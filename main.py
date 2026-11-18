import os
import hmac
import html
import json
import re
import time
import random
import unicodedata
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Annotated, Optional, List, Dict, Any, Literal
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import Request as UpstreamRequest, urlopen

import numpy as np
import pandas as pd
from fastapi import Depends, FastAPI, HTTPException, Path, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field
from translation_models import translate_locally
from recommendation_engine import GENRES, RecommendationIndex, load_cast
from synopsis_quality import clean_synopsis

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    if os.path.exists(".env"):
        with open(".env") as f:
            for line in f:
                if line.strip() and not line.startswith("#"):
                    key, val = line.strip().split("=", 1)
                    os.environ[key] = val

# Global state containers for low-latency memory lookup
DATA_STORE: Dict[str, Any] = {
    "df_movies": None,
    "search_titles": None,
    "embeddings_norm": None,
    "recommendation_index": None,
    "title_to_index": {},
    "user_recommendations": {},
    "sample_user_ids": [],
    "total_users": 0,
    "total_movies": 0,
    "is_loaded": False,
}

PKL_PATH = "data/movies_with_embeddings.pkl"
CSV_PATH = "data/export_final_recommendations_top10_part-00000-d07c0c1a-98a2-472f-aa5f-7d03909d98ba-c000.csv"
CATALOG_RATINGS_PATH = "data/catalog_tmdb_ratings.csv"
CatalogSort = Literal["archive", "rating-desc", "rating-asc", "votes-desc", "year-desc", "year-asc", "title-asc", "title-desc"]
SynopsisLanguage = Literal['tr', 'en', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'zh-CN', 'hi']


def normalize_catalog_query(text: str) -> str:
    """Case/accent-insensitive lookup, including Turkish I/İ/ı spellings."""
    folded = unicodedata.normalize("NFKD", text.casefold().replace("ı", "i"))
    return "".join(char for char in folded if not unicodedata.combining(char))


def attach_catalog_ratings(movies: pd.DataFrame) -> None:
    if not os.path.isfile(CATALOG_RATINGS_PATH):
        return
    columns = {"movieId": "int64", "tmdb_rating": "float64", "tmdb_votes": "int64"}
    try:
        ratings = pd.read_csv(CATALOG_RATINGS_PATH, usecols=columns.keys(), dtype=columns)
    except (OSError, ValueError) as error:
        print(f"[WARN] Could not read catalogue rating index: {error}")
        return
    ratings = ratings[ratings["tmdb_rating"].between(0, 10) & (ratings["tmdb_votes"] > 0)]
    ratings = ratings.drop_duplicates("movieId").set_index("movieId")
    movies["tmdb_rating"] = movies["movieId"].map(ratings["tmdb_rating"])
    movies["tmdb_votes"] = movies["movieId"].map(ratings["tmdb_votes"]).fillna(0).astype(int)
    print(f"[OK] Indexed TMDB scores for {movies['tmdb_rating'].count()} catalogue movies")


def load_backend_data():
    """Efficiently load PKL embeddings matrix and Collaborative Filtering CSV into memory."""
    print("[INFO] Starting data loading into memory...")
    start_time = time.time()

    # 1. Load movies with embeddings
    if not os.path.exists(PKL_PATH):
        raise FileNotFoundError(f"Missing required data file: {PKL_PATH}")

    df_movies = pd.read_pickle(PKL_PATH)

    # Extract year from title using Regex (e.g., "Toy Story (1995)" -> 1995)
    df_movies["year"] = df_movies["title"].str.extract(r'\((\d{4})\)', expand=False)
    # Convert to numeric, handle missing/failed parsing by filling with 0, cast to int
    df_movies["year"] = pd.to_numeric(df_movies["year"], errors='coerce').fillna(0).astype(int)

    # Ensure required columns exist
    for col in ["movieId", "title", "embedding", "year"]:
        if col not in df_movies.columns:
            raise KeyError(f"Missing column '{col}' in {PKL_PATH}")

    if "overview" not in df_movies.columns:
        df_movies["overview"] = ""
    if "genres" not in df_movies.columns:
        df_movies["genres"] = ""

    # Clean overview and genres NaNs
    df_movies["overview"] = df_movies["overview"].fillna("No overview available.")
    df_movies["genres"] = df_movies["genres"].fillna("")

    # Filter out movies with less than 23 words in their overview
    df_movies = df_movies[df_movies["overview"].str.split().str.len() >= 23].reset_index(drop=True)
    attach_catalog_ratings(df_movies)

    # Convert embeddings to 2D numpy matrix and L2 normalize for cosine similarity
    raw_embeddings = np.vstack(df_movies["embedding"].values).astype(np.float32)
    norms = np.linalg.norm(raw_embeddings, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    embeddings_norm = raw_embeddings / norms

    # Fast title to index mapping (normalized lowercase mapping for flexible search)
    title_to_index = {}
    for idx, title in enumerate(df_movies["title"]):
        if isinstance(title, str):
            clean_title = title.strip().lower()
            if clean_title not in title_to_index:
                title_to_index[clean_title] = idx

    DATA_STORE["df_movies"] = df_movies
    DATA_STORE["search_titles"] = df_movies["title"].fillna("").map(normalize_catalog_query)
    DATA_STORE["embeddings_norm"] = embeddings_norm
    DATA_STORE["title_to_index"] = title_to_index
    DATA_STORE["recommendation_index"] = RecommendationIndex(df_movies, embeddings_norm, load_cast())
    DATA_STORE["total_movies"] = len(df_movies)

    print(f"[OK] Loaded {len(df_movies)} movie embeddings matrix ({embeddings_norm.shape}) in {time.time() - start_time:.2f}s")
    print(f"[OK] Indexed leading cast for {len(DATA_STORE['recommendation_index'].cast)} catalogue movies")

    # 2. Load Collaborative Filtering CSV Recommendations
    if os.environ.get('CINEFLOW_DEMO_TOKEN', '').strip() and os.path.isfile(CSV_PATH):
        csv_start = time.time()
        df_csv = pd.read_csv(CSV_PATH)
        
        # Optimize storage: pre-group recommendations by userId into dictionary
        user_recs = {}
        for r in df_csv.itertuples(index=False):
            u_id = int(r.userId)
            if u_id not in user_recs:
                user_recs[u_id] = []
            user_recs[u_id].append({
                "movieId": int(r.movieId),
                "title": str(r.title) if pd.notna(r.title) else "",
                "genres": str(r.genres) if pd.notna(r.genres) else "",
                "predicted_rating": round(float(r.predicted_rating), 2)
            })

        DATA_STORE["user_recommendations"] = user_recs
        DATA_STORE["total_users"] = len(user_recs)
        
        # Pick 10 sample user IDs across range for quick testing
        sorted_users = sorted(list(user_recs.keys()))
        if sorted_users:
            step = max(1, len(sorted_users) // 10)
            sample_ids = sorted_users[::step][:10]
            DATA_STORE["sample_user_ids"] = sample_ids

        print(f"[OK] Loaded collaborative filtering picks for {len(user_recs)} users in {time.time() - csv_start:.2f}s")

    DATA_STORE["is_loaded"] = True
    print(f"[OK] Data initialization complete in {time.time() - start_time:.2f}s total!")


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_backend_data()
    yield


app = FastAPI(
    title="CineFlow API",
    description="İşbirlikçi Filtreleme ve NLP Vektör Benzerliği önerileri için yüksek performanslı backend API.",
    version="1.0.0",
    lifespan=lifespan,
)

# CORS Configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:8001", "http://127.0.0.1:8001"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- Cyber Security Kalkanı ---

# 1. IP tabanlı basit Rate Limiting (1 dakikada max 100 istek)
RATE_LIMIT_STORE = {}
RATE_LIMIT_MAX = 100
POSTER_RATE_LIMIT_MAX = 240
RATE_LIMIT_WINDOW = 60.0 # saniye
_rate_limit_sweep_at = 0.0

@app.middleware("http")
async def rate_limiter(request: Request, call_next):
    # Statik dosyalara hız sınırı koyma
    if request.url.path.startswith("/static"):
        return await call_next(request)
        
    global _rate_limit_sweep_at
    client_ip = request.client.host if request.client else "unknown"
    current_time = time.monotonic()
    cutoff = current_time - RATE_LIMIT_WINDOW
    if current_time >= _rate_limit_sweep_at:
        for bucket, timestamps in list(RATE_LIMIT_STORE.items()):
            if timestamps[-1] <= cutoff:
                del RATE_LIMIT_STORE[bucket]
        _rate_limit_sweep_at = current_time + RATE_LIMIT_WINDOW

    is_poster = request.url.path == '/api/movie-posters'
    bucket = (client_ip, is_poster)
    timestamps = [t for t in RATE_LIMIT_STORE.get(bucket, ()) if t > cutoff]
    limit = POSTER_RATE_LIMIT_MAX if is_poster else RATE_LIMIT_MAX
    if len(timestamps) >= limit:
        return JSONResponse(
            status_code=429,
            content={"detail": "Too Many Requests - Rate limit exceeded. Bot behavior detected."}
        )
        
    timestamps.append(current_time)
    RATE_LIMIT_STORE[bucket] = timestamps
    return await call_next(request)

# 2. Güvenlik Başlıkları (Security Headers)
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    response.headers["Referrer-Policy"] = "no-referrer"
    return response


@lru_cache(maxsize=1024)
def translate_overview(text: str, target: str) -> str:
    localized = translate_locally(text, target)
    if localized:
        return localized

    api_key = os.environ.get('GOOGLE_TRANSLATE_API_KEY', '').strip()
    if not api_key:
        raise ValueError('Translation unavailable locally')
    request = UpstreamRequest(
        'https://translation.googleapis.com/language/translate/v2?' + urlencode({'key': api_key}),
        data=json.dumps({'q': text, 'target': target, 'format': 'text'}).encode('utf-8'),
        headers={'Content-Type': 'application/json'},
    )
    with urlopen(request, timeout=8) as response:
        result = json.load(response)['data']['translations'][0]

    translated = html.unescape(result['translatedText']).strip()
    detected_language = result.get('detectedSourceLanguage', '').lower()
    if not translated or (translated.casefold() == text.casefold() and detected_language != target.lower()):
        raise ValueError('Translation provider did not return a translation')
    return translated


def archive_movie(movie_id: int):
    index = DATA_STORE['recommendation_index']
    if index is None:
        raise HTTPException(status_code=503, detail='Film arşivi henüz yükleniyor.')
    position = index.by_id.get(movie_id)
    if position is None:
        raise HTTPException(status_code=404, detail='Film bulunamadı.')
    return index.movies.iloc[position]


@app.get('/movies/{movie_id}/synopsis')
def get_movie_synopsis(movie_id: Annotated[int, Path(gt=0)], language: SynopsisLanguage = 'tr'):
    text = clean_synopsis(archive_movie(movie_id)['overview'])
    if text:
        try:
            text = clean_synopsis(translate_overview(text, language))
        except (URLError, TimeoutError, ValueError, KeyError, IndexError, TypeError, AttributeError):
            text = ''
        if not text:
            raise HTTPException(status_code=502, detail='Film özeti şu anda kullanılamıyor.')
    return {'movieId': movie_id, 'language': language, 'text': text}

# Ensure static directory exists
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")


# Pydantic Schemas
class MovieRecommendationItem(BaseModel):
    movieId: int
    title: str
    genres: str
    predicted_rating: float


class ContentBasedMovieItem(BaseModel):
    movieId: int
    title: str
    genres: str
    overview: str
    similarity_score: float


class SessionRecommendations(BaseModel):
    liked_ids: List[int] = Field(default_factory=list, max_length=20)
    passed_ids: List[int] = Field(default_factory=list, max_length=20)
    previous_ids: List[int] = Field(default_factory=list, max_length=25)
    min_year: Optional[int] = None
    max_year: Optional[int] = None
    genres: List[str] = Field(default_factory=list, max_length=len(GENRES))
    variation: int = Field(default=0, ge=0, le=2**32 - 1)
    limit: int = Field(default=25, ge=1, le=25)


def validate_film_filters(min_year, max_year, genres):
    if min_year is not None and max_year is not None and min_year > max_year:
        raise HTTPException(status_code=422, detail="Başlangıç yılı bitiş yılından büyük olamaz.")
    selected = set(genres or [])
    if selected.difference(GENRES):
        raise HTTPException(status_code=422, detail="Geçersiz film türü.")
    return tuple(genre for genre in GENRES if genre in selected)


@app.post("/session-recommendations")
def get_session_recommendations(payload: SessionRecommendations):
    index = DATA_STORE["recommendation_index"]
    if not DATA_STORE["is_loaded"] or index is None:
        raise HTTPException(status_code=503, detail="Veriler henüz belleğe yükleniyor.")
    genres = validate_film_filters(payload.min_year, payload.max_year, payload.genres)
    likes, passes = set(payload.liked_ids), set(payload.passed_ids)
    if likes & passes or len(likes | passes) > 20 or not (likes | passes).issubset(index.by_id):
        raise HTTPException(status_code=422, detail="Geçersiz film kararları.")
    results = index.recommend(
        likes, passes, min_year=payload.min_year, max_year=payload.max_year, genres=genres,
        variation=payload.variation, previous_ids=payload.previous_ids, limit=payload.limit,
    )
    return {"movies": results}


# Helper Functions
def find_movie_index(query_title: str) -> Optional[int]:
    """Find movie index using exact match, normalized lower case, or partial substring match."""
    df_movies = DATA_STORE["df_movies"]
    title_to_index = DATA_STORE["title_to_index"]

    if df_movies is None:
        return None

    clean_query = query_title.strip().lower()
    if not clean_query:
        return None

    # 1. Exact match in index
    if clean_query in title_to_index:
        return title_to_index[clean_query]

    # 2. Check if numeric index passed
    if clean_query.isdigit():
        idx = int(clean_query)
        if 0 <= idx < len(df_movies):
            return idx

    # 3. Substring match (first title containing clean_query)
    for idx, title in enumerate(df_movies["title"]):
        if isinstance(title, str) and clean_query in title.lower():
            return idx

    return None


# API Routes

@lru_cache(maxsize=4096)
def lookup_movie_poster(title: str, api_key: str):
    year_match = re.search(r'\s*\((\d{4})\)\s*$', title)
    name = title[:year_match.start()].strip() if year_match else title.strip()
    year = year_match[1] if year_match else None
    article = re.fullmatch(r'(.+),\s*(The|A|An)', name, re.IGNORECASE)
    if article:
        name = f'{article[2]} {article[1]}'

    params = {'api_key': api_key, 'query': name, 'language': 'tr-TR', 'page': '1', 'include_adult': 'false'}
    for search_year in (year, None) if year else (None,):
        if search_year:
            params['year'] = search_year
        else:
            params.pop('year', None)
        with urlopen('https://api.themoviedb.org/3/search/movie?' + urlencode(params), timeout=5) as response:
            results = json.load(response)['results']
        if results:
            break
    if not results:
        return {'poster_path': None, 'rating': 0}

    def title_key(value):
        return ''.join(char for char in unicodedata.normalize('NFKC', value or '').lower() if char.isalnum())

    names = {title_key(name), title_key(re.sub(r'\s+\([^()]+\)$', '', name))}
    matches = [result for result in results
               if (not year or (result.get('release_date') or '').startswith(year + '-'))
               and any(title_key(result.get(field)) in names for field in ('title', 'original_title'))]
    candidates = [result for result in matches if result.get('poster_path')] or matches
    candidates = candidates or [result for result in results if result.get('poster_path')] or results
    result = candidates[0]
    path = result.get('poster_path') or ''
    return {
        'poster_path': path if re.fullmatch(r'/[A-Za-z0-9_-]+\.(?:jpg|png|webp)', path) else None,
        'rating': float(result.get('vote_average') or 0),
    }


@app.get('/api/movie-posters')
def get_movie_poster(movie_id: Annotated[int, Query(gt=0)]):
    title = archive_movie(movie_id)['title']
    api_key = os.environ.get('TMDB_API_KEY', '').strip()
    if not api_key:
        return {'poster_path': None, 'rating': 0}
    try:
        return lookup_movie_poster(title, api_key)
    except (URLError, TimeoutError, ValueError, KeyError, IndexError, TypeError, AttributeError):
        raise HTTPException(status_code=502, detail='Poster bilgisi şu anda kullanılamıyor.') from None


_demo_auth = HTTPBearer(auto_error=False)


def require_demo_token(credentials: Annotated[Optional[HTTPAuthorizationCredentials], Depends(_demo_auth)]):
    token = os.environ.get('CINEFLOW_DEMO_TOKEN', '').strip()
    if not token:
        raise HTTPException(status_code=404, detail='Demo uç noktası kapalı.')
    if credentials is None or not hmac.compare_digest(credentials.credentials.encode(), token.encode()):
        raise HTTPException(status_code=401, detail='Yetkilendirme gerekli.', headers={'WWW-Authenticate': 'Bearer'})

@app.get("/health")
def health_check():
    return {
        "status": "online",
        "data_loaded": DATA_STORE["is_loaded"],
        "total_movies": DATA_STORE["total_movies"],
        "total_users": DATA_STORE["total_users"],
    }


@app.get("/recommendations/{user_id}", response_model=List[MovieRecommendationItem], dependencies=[Depends(require_demo_token)])
def get_user_recommendations(user_id: int, response: Response):
    """
    Returns collaborative filtering top movie picks for a specific user.
    """
    if not DATA_STORE["is_loaded"]:
        raise HTTPException(status_code=503, detail="Veriler henüz belleğe yükleniyor.")

    user_recs = DATA_STORE["user_recommendations"].get(user_id)
    if not user_recs:
        raise HTTPException(
            status_code=404, 
            detail=f"Kullanıcı ID {user_id} bulunamadı. Lütfen geçerli bir Kullanıcı ID deneyin (ör. {DATA_STORE['sample_user_ids'][:5]})."
        )

    response.headers['Cache-Control'] = 'no-store'
    return user_recs


@app.get("/similar")
def get_similar_movies(
    movie_title: str = Query(..., description="Benzerleri hesaplanacak filmin adı"),
    limit: int = Query(10, ge=1, le=50, description="Döndürülecek benzer film sayısı"),
    min_year: Optional[int] = Query(None, description="Minimum çıkış yılı"),
    max_year: Optional[int] = Query(None, description="Maksimum çıkış yılı")
):
    """
    Computes cosine similarity using the L2-normalized embedding matrix and returns top content-based matches.
    """
    if not DATA_STORE["is_loaded"]:
        raise HTTPException(status_code=503, detail="Veriler henüz belleğe yükleniyor.")

    target_idx = find_movie_index(movie_title)
    if target_idx is None:
        raise HTTPException(
            status_code=404,
            detail=f"'{movie_title}' filmi veritabanında bulunamadı. Arama kısmını kullanarak tekrar deneyin."
        )

    df_movies = DATA_STORE["df_movies"]
    embeddings_norm = DATA_STORE["embeddings_norm"]

    target_movie = df_movies.iloc[target_idx]
    query_vector = embeddings_norm[target_idx].astype(np.float32)

    # Optimized NumPy dot product vector lookup (Cosine similarity across 56k vectors)
    similarities = np.dot(embeddings_norm, query_vector)

    # Top (limit + 1) indices (to exclude self-match)
    top_indices = np.argsort(similarities)[::-1]
    
    # Filter out target movie itself
    results = []
    for idx in top_indices:
        if idx == target_idx:
            continue

        row = df_movies.iloc[idx]
        
        # Apply Year Filter for Recommendations
        year = int(row.get("year", 0))
        if min_year is not None and year < min_year:
            continue
        if max_year is not None and year > max_year:
            continue

        sim_val = float(similarities[idx])

        results.append({
            "movieId": int(row["movieId"]),
            "title": str(row["title"]),
            "genres": str(row["genres"]),
            "overview": str(row["overview"]),
            "similarity_score": round(sim_val, 4),
            "similarity_percent": f"%{round(sim_val * 100, 1)}"
        })

        if len(results) >= limit:
            break

    return {
        "query_movie": {
            "movieId": int(target_movie["movieId"]),
            "title": str(target_movie["title"]),
            "genres": str(target_movie["genres"]),
            "overview": str(target_movie["overview"]),
        },
        "similar_movies": results
    }


@app.get("/search")
def search_movies(
    q: str = Query(..., min_length=1, description="Movie search query"),
    limit: int = Query(8, ge=1, le=20)
):
    """
    Fast title autocomplete / search endpoint.
    """
    if not DATA_STORE["is_loaded"]:
        return []

    df_movies = DATA_STORE["df_movies"]
    clean_q = q.strip().lower()

    matches = []
    # Direct substring matches
    for idx, row in df_movies.iterrows():
        title = str(row["title"])
        if clean_q in title.lower():
            matches.append({
                "movieId": int(row["movieId"]),
                "title": title,
                "genres": str(row["genres"]),
                "overview": str(row["overview"])[:150] + "..." if len(str(row["overview"])) > 150 else str(row["overview"])
            })
            if len(matches) >= limit:
                break

    return matches


@app.get("/cold-start")
def get_cold_start_movies(
    count: int = Query(10, ge=5, le=20, description="Number of cold start movies"),
    min_year: Optional[int] = Query(None, description="Minimum çıkış yılı"),
    max_year: Optional[int] = Query(None, description="Maksimum çıkış yılı"),
    genres: Annotated[Optional[List[str]], Query(max_length=len(GENRES))] = None,
):
    """
    Returns random movies from diverse genres for cold start onboarding.
    Each movie comes from a different primary genre to gauge user preferences, filtered by year range.
    """
    if not DATA_STORE["is_loaded"]:
        raise HTTPException(status_code=503, detail="Veriler henüz belleğe yükleniyor.")

    selected = validate_film_filters(min_year, max_year, genres)
    index = DATA_STORE["recommendation_index"]
    eligible = index.eligible(min_year, max_year, selected)
    buckets = list(selected or GENRES)
    random.shuffle(buckets)
    choices, titles = [], set()

    def add_one(candidates):
        random.shuffle(candidates)
        for candidate in candidates:
            title = index.title_keys[candidate]
            if title and title not in titles:
                choices.append(candidate)
                titles.add(title)
                break

    for genre in buckets:
        if len(choices) == count:
            break
        mask = eligible & (index.genre_matrix[:, index.genre_index[genre]] > 0)
        add_one(np.flatnonzero(mask).tolist())
    if len(choices) < count:
        remaining = np.flatnonzero(eligible).tolist()
        random.shuffle(remaining)
        for candidate in remaining:
            if len(choices) == count:
                break
            title = index.title_keys[candidate]
            if title and title not in titles:
                choices.append(candidate)
                titles.add(title)
    random.shuffle(choices)
    return {"movies": index.movies.iloc[choices][["movieId", "title", "genres", "overview", "year"]].to_dict("records")}


@app.get("/movies")
def get_all_movies(
    page: int = Query(1, ge=1, description="Sayfa numarası"),
    limit: int = Query(50, ge=1, le=100, description="Sayfa başına film sayısı"),
    q: str = Query("", max_length=200, description="Yerel veri kümesinde film adı araması"),
    sort: CatalogSort = "archive",
    genre: Annotated[str, Query(max_length=40)] = "",
    year: Annotated[Optional[int], Query(ge=1800, le=2100)] = None,
    min_rating: Annotated[Optional[float], Query(ge=0, le=10)] = None,
):
    """
    Returns a paginated list of all movies in the database.
    """
    if not DATA_STORE["is_loaded"]:
        raise HTTPException(status_code=503, detail="Veriler henüz belleğe yükleniyor.")

    df_movies = DATA_STORE["df_movies"]
    has_ratings = "tmdb_rating" in df_movies
    rating_available = has_ratings and bool(df_movies["tmdb_rating"].notna().any())
    query = normalize_catalog_query(q.strip())
    if query or sort.startswith("title-"):
        search_titles = DATA_STORE.get("search_titles")
        if search_titles is None:
            search_titles = df_movies["title"].fillna("").map(normalize_catalog_query)
    if query:
        df_movies = df_movies.loc[search_titles.str.contains(query, regex=False, na=False)]
    genre = genre.strip().lower()
    if genre:
        genre_list = "|" + df_movies["genres"].str.lower() + "|"
        df_movies = df_movies.loc[genre_list.str.contains(f"|{genre}|", regex=False, na=False)]
    if year is not None:
        df_movies = df_movies.loc[df_movies["year"] == year]
    if min_rating is not None:
        df_movies = df_movies.loc[df_movies["tmdb_rating"] >= min_rating] if has_ratings else df_movies.iloc[:0]

    # Sort the entire matching set before applying the page offset.
    if has_ratings and sort in ("rating-desc", "rating-asc"):
        df_movies = df_movies.sort_values(
            ["tmdb_rating", "tmdb_votes", "movieId"], ascending=[sort == "rating-asc", False, True], na_position="last"
        )
    elif has_ratings and sort == "votes-desc":
        df_movies = df_movies.sort_values(["tmdb_votes", "movieId"], ascending=[False, True])
    elif sort.startswith("year-"):
        df_movies = df_movies.sort_values(
            ["year", "movieId"], ascending=[sort == "year-asc", True],
            key=lambda col: col.mask(col.eq(0)) if col.name == "year" else col,
        )
    elif sort.startswith("title-"):
        df_movies = df_movies.assign(sort_title=search_titles).sort_values(
            ["sort_title", "movieId"], ascending=[sort == "title-asc", True]
        )

    total_movies = len(df_movies)
    total_pages = (total_movies + limit - 1) // limit

    if page > total_pages and total_pages > 0:
        page = total_pages
    elif total_pages == 0:
        page = 1

    start_idx = (page - 1) * limit
    end_idx = start_idx + limit

    batch_df = df_movies.iloc[start_idx:end_idx]

    results = []
    for _, row in batch_df.iterrows():
        rating = row.get("tmdb_rating")
        results.append({
            "movieId": int(row["movieId"]),
            "title": str(row["title"]),
            "genres": str(row["genres"]),
            "overview": str(row["overview"]),
            "year": int(row.get("year", 0)),
            "tmdb_rating": float(rating) if pd.notna(rating) else None,
            "tmdb_votes": int(row.get("tmdb_votes", 0)),
        })

    return {
        "page": page,
        "total_pages": total_pages,
        "total_movies": total_movies,
        "limit": limit,
        "rating_available": rating_available,
        "movies": results
    }


@app.get("/sample-users", dependencies=[Depends(require_demo_token)])
def get_sample_users(response: Response):
    response.headers['Cache-Control'] = 'no-store'
    return {
        "sample_user_ids": DATA_STORE["sample_user_ids"],
        "total_users": DATA_STORE["total_users"]
    }


@app.get("/")
def serve_index():
    """Serves the main web app interface."""
    index_file = os.path.join("static", "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file, headers={"Cache-Control": "no-cache"})
    return JSONResponse({"message": "Movie Recommendation API is active. Static frontend file is missing."})
