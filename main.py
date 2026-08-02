import os
import time
import random
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Any

import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

import os
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
    "embeddings_norm": None,
    "title_to_index": {},
    "user_recommendations": {},
    "sample_user_ids": [],
    "total_users": 0,
    "total_movies": 0,
    "is_loaded": False,
}

PKL_PATH = "data/movies_with_embeddings.pkl"
CSV_PATH = "data/export_final_recommendations_top10_part-00000-d07c0c1a-98a2-472f-aa5f-7d03909d98ba-c000.csv"


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

    # Pre-compute genre indices for O(1) filtering in cold-start
    genre_buckets = [
        "Action", "Comedy", "Drama", "Sci-Fi", "Horror",
        "Romance", "Thriller", "Animation", "Adventure", "Crime",
        "Fantasy", "Mystery", "Documentary", "War", "Musical"
    ]
    genre_indices = {}
    for genre in genre_buckets:
        mask = df_movies["genres"].str.contains(genre, na=False, regex=False)
        genre_indices[genre] = df_movies.index[mask].tolist()

    DATA_STORE["df_movies"] = df_movies
    DATA_STORE["embeddings_norm"] = embeddings_norm
    DATA_STORE["title_to_index"] = title_to_index
    DATA_STORE["genre_indices"] = genre_indices
    DATA_STORE["total_movies"] = len(df_movies)

    print(f"[OK] Loaded {len(df_movies)} movie embeddings matrix ({embeddings_norm.shape}) in {time.time() - start_time:.2f}s")

    # 2. Load Collaborative Filtering CSV Recommendations
    if not os.path.exists(CSV_PATH):
        print(f"[WARN] {CSV_PATH} not found. User recommendations endpoint will be empty.")
        DATA_STORE["user_recommendations"] = {}
    else:
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
RATE_LIMIT_WINDOW = 60.0 # saniye

@app.middleware("http")
async def rate_limiter(request: Request, call_next):
    # Statik dosyalara hız sınırı koyma
    if request.url.path.startswith("/static"):
        return await call_next(request)
        
    client_ip = request.client.host if request.client else "unknown"
    current_time = time.time()
    
    if client_ip not in RATE_LIMIT_STORE:
        RATE_LIMIT_STORE[client_ip] = []
        
    # Temizle
    RATE_LIMIT_STORE[client_ip] = [t for t in RATE_LIMIT_STORE[client_ip] if current_time - t < RATE_LIMIT_WINDOW]
    
    if len(RATE_LIMIT_STORE[client_ip]) >= RATE_LIMIT_MAX:
        return JSONResponse(
            status_code=429,
            content={"detail": "Too Many Requests - Rate limit exceeded. Bot behavior detected."}
        )
        
    RATE_LIMIT_STORE[client_ip].append(current_time)
    return await call_next(request)

# 2. Güvenlik Başlıkları (Security Headers)
@app.middleware("http")
async def add_security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response

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


# Helper Functions
def find_movie_index(query_title: str) -> Optional[int]:
    """Find movie index using exact match, normalized lower case, or partial substring match."""
    df_movies = DATA_STORE["df_movies"]
    title_to_index = DATA_STORE["title_to_index"]

    if df_movies is None:
        return None

    clean_query = query_title.strip().lower()

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

@app.get("/api/config")
def get_config():
    """Returns frontend configuration securely from the backend environment."""
    return {"TMDB_API_KEY": os.environ.get("TMDB_API_KEY", "")}

@app.get("/health")
def health_check():
    return {
        "status": "online",
        "data_loaded": DATA_STORE["is_loaded"],
        "total_movies": DATA_STORE["total_movies"],
        "total_users": DATA_STORE["total_users"],
    }


@app.get("/recommendations/{user_id}", response_model=List[MovieRecommendationItem])
def get_user_recommendations(user_id: int):
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
    max_year: Optional[int] = Query(None, description="Maksimum çıkış yılı")
):
    """
    Returns random movies from diverse genres for cold start onboarding.
    Each movie comes from a different primary genre to gauge user preferences, filtered by year range.
    """
    if not DATA_STORE["is_loaded"]:
        raise HTTPException(status_code=503, detail="Veriler henüz belleğe yükleniyor.")

    df_movies = DATA_STORE["df_movies"]
    
    # 1. Fast Vectorized Year Filtering
    mask = pd.Series(True, index=df_movies.index)
    if min_year is not None:
        mask &= (df_movies["year"] >= min_year)
    if max_year is not None:
        mask &= (df_movies["year"] <= max_year)
        
    filtered_df = df_movies[mask]

    # Define diverse primary genre buckets
    genre_buckets = [
        "Action", "Comedy", "Drama", "Sci-Fi", "Horror",
        "Romance", "Thriller", "Animation", "Adventure", "Crime",
        "Fantasy", "Mystery", "Documentary", "War", "Musical"
    ]

    selected_movies = []
    used_indices = set()

    # 2. Fast Genre Filtering
    for genre in genre_buckets:
        if len(selected_movies) >= count:
            break

        # Fast pre-computed index lookup
        indices_for_genre = DATA_STORE["genre_indices"].get(genre, [])
        if not indices_for_genre:
            continue
            
        # Intersect with year filter
        valid_indices = list(set(indices_for_genre).intersection(set(filtered_df.index)))
        
        if valid_indices:
            # Create a dataframe slice from the valid indices
            genre_df = df_movies.loc[valid_indices]
        
        if not genre_df.empty:
            # Take up to 50 random samples and pick the first good one (with valid overview)
            candidates = genre_df.sample(n=min(50, len(genre_df)))
            
            for idx, row in candidates.iterrows():
                if idx not in used_indices and isinstance(row["title"], str) and len(row["title"]) > 2:
                    overview = str(row.get("overview", ""))
                    if overview and overview != "No overview available." and len(overview) > 50:
                        used_indices.add(idx)
                        selected_movies.append({
                            "movieId": int(row["movieId"]),
                            "title": str(row["title"]),
                            "genres": str(row["genres"]),
                            "overview": str(row["overview"]),
                        })
                        break

    # Shuffle the final list so genres aren't in a predictable order
    random.shuffle(selected_movies)

    return {"movies": selected_movies[:count]}


@app.get("/movies")
def get_all_movies(
    page: int = Query(1, ge=1, description="Sayfa numarası"),
    limit: int = Query(50, ge=1, le=100, description="Sayfa başına film sayısı")
):
    """
    Returns a paginated list of all movies in the database.
    """
    if not DATA_STORE["is_loaded"]:
        raise HTTPException(status_code=503, detail="Veriler henüz belleğe yükleniyor.")

    df_movies = DATA_STORE["df_movies"]
    total_movies = len(df_movies)
    total_pages = (total_movies + limit - 1) // limit

    if page > total_pages and total_pages > 0:
        page = total_pages

    start_idx = (page - 1) * limit
    end_idx = start_idx + limit

    batch_df = df_movies.iloc[start_idx:end_idx]

    results = []
    for _, row in batch_df.iterrows():
        results.append({
            "movieId": int(row["movieId"]),
            "title": str(row["title"]),
            "genres": str(row["genres"]),
            "overview": str(row["overview"]),
            "year": int(row.get("year", 0))
        })

    return {
        "page": page,
        "total_pages": total_pages,
        "total_movies": total_movies,
        "limit": limit,
        "movies": results
    }


@app.get("/sample-users")
def get_sample_users():
    return {
        "sample_user_ids": DATA_STORE["sample_user_ids"],
        "total_users": DATA_STORE["total_users"]
    }


@app.get("/")
def serve_index():
    """Serves the main web app interface."""
    index_file = os.path.join("static", "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    return JSONResponse({"message": "Movie Recommendation API is active. Static frontend file is missing."})
