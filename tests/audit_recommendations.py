"""Read-only catalogue and recommendation audit using the production Python functions."""

from collections import Counter, defaultdict
from pathlib import Path
from statistics import mean
from unittest.mock import patch
import json
import os
import random
import sys

import numpy as np
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import main

OUT = ROOT / 'tmp' / 'recommendation-audit'
SEEDS = (
    'Matrix, The (1999)', 'John Wick (2014)', 'Toy Story (1995)', 'Conjuring, The (2013)',
    'Interstellar (2014)', 'Jurassic Park (1993)', 'Titanic (1997)', 'Forrest Gump (1994)',
    'Devil Wears Prada, The (2006)', 'Inception (2010)', 'Matrix Reloaded, The (2003)',
)
GENRES = ('Action', 'Animation', 'Comedy', 'Documentary', 'Drama', 'Horror', 'Romance', 'Sci-Fi')
ERAS = {
    'all': (None, None), '1970–1990': (1970, 1990), '1990–2010': (1990, 2010), '2010–2026': (2010, 2026),
}


def genres(value):
    return set(value.split('|')) - {'', '(no genres listed)'}


def similar(title, lower=None, upper=None, limit=15):
    return main.get_similar_movies(movie_title=title, limit=limit, min_year=lower, max_year=upper)


def outcome(function):
    try:
        return function()
    except HTTPException as error:
        return {'status': error.status_code}
    except Exception as error:
        return {'error': type(error).__name__}


def main_audit():
    os.chdir(ROOT)
    OUT.mkdir(parents=True, exist_ok=True)
    random.seed(20261118)
    np.random.seed(20261118)
    rng = np.random.default_rng(20261118)
    # Collaborative predictions are not a dependency of the audited functions.
    with patch.object(main, 'CSV_PATH', str(OUT / 'unused-collaborative-file.csv')):
        main.load_backend_data()

    films = main.DATA_STORE['df_movies']
    year = dict(zip(films.movieId, films.year))
    vector = main.DATA_STORE['embeddings_norm']
    title_keys = films.title.str.strip().str.lower()
    repeated = films[title_keys.duplicated(keep=False) & films.title.notna()]
    valid_years = films.year[films.year > 0]
    all_genres = [genres(x) for x in films.genres]
    primary_counts = Counter()
    all_indices_by_genre = defaultdict(set)
    for i, labels in enumerate(all_genres):
        for label in labels:
            all_indices_by_genre[label].add(i)

    report = {
        'data': {
            'movies': len(films), 'features': list(films.columns),
            'vector_shape': list(vector.shape), 'non_finite': int((~np.isfinite(vector)).sum()),
            'zero_vectors': int((np.linalg.norm(vector, axis=1) == 0).sum()),
            'unknown_year': int((films.year == 0).sum()),
            'min_year': int(valid_years.min()), 'max_year': int(valid_years.max()),
            'after_2019': int((films.year > 2019).sum()),
            'repeated_movie_ids': int(films.movieId.duplicated().sum()),
            'ambiguous_title_count': int(repeated.title.str.strip().str.lower().nunique()),
            'ambiguous_title_example': [],
        },
        'decks': {}, 'api_edges': {}, 'curated': {}, 'genre_benchmark': {}, 'mixed_seeds': [],
    }
    if not repeated.empty:
        title = repeated.title.iloc[0]
        matching = repeated[repeated.title.str.strip().str.lower() == title.strip().lower()]
        chosen_id = int(similar(title, limit=1)['query_movie']['movieId'])
        report['data']['ambiguous_title_example'] = {
            'title': title, 'movie_ids': matching.movieId.tolist(), 'selected_by_api': chosen_id,
        }

    session_decks = []
    for label, (lower, upper) in ERAS.items():
        sizes, genre_counts, era_mismatch = [], [], 0
        for _ in range(24):
            deck = main.get_cold_start_movies(count=10, min_year=lower, max_year=upper)['movies']
            session_decks.append((lower, upper, deck))
            sizes.append(len(deck))
            genre_counts.append(len(set().union(*(genres(movie['genres']) for movie in deck))))
            ids = [movie['movieId'] for movie in deck]
            assert len(ids) == len(set(ids))
            era_mismatch += sum(
                (lower is not None and year[mid] < lower) or (upper is not None and year[mid] > upper) for mid in ids
            )
            for movie in deck:
                primary_counts.update(genres(movie['genres']))
        report['decks'][label] = {'sizes': dict(Counter(sizes)), 'avg_distinct_genres': round(mean(genre_counts), 2),
                                  'year_mismatches': era_mismatch}

    def deck_count(lower=None, upper=None, count=10):
        return len(main.get_cold_start_movies(count=count, min_year=lower, max_year=upper)['movies'])

    report['api_edges'] = {
        'blank_title': outcome(lambda: similar(' ', limit=1)['query_movie']['title']),
        'unknown_title': outcome(lambda: similar('Film bulunamadı test anahtarı 461')),
        'no_year_data': outcome(lambda: deck_count(2022, 2026)),
        'reversed_years': outcome(lambda: deck_count(2015, 1990)),
        'count_20': outcome(lambda: deck_count(count=20)),
        'year_filtered_similar': [
            {'title': movie['title'], 'year': year[movie['movieId']]}
            for movie in similar(SEEDS[0], 2010, 2026, limit=10)['similar_movies']
        ],
    }

    for seed in SEEDS:
        report['curated'][seed] = outcome(lambda: similar(seed))

    used = set()
    ordering_checks = 0
    for genre in GENRES:
        pool = sorted(all_indices_by_genre[genre] - used)
        selected = rng.choice(pool, 12, replace=False).tolist()
        used.update(selected)
        exact, any_genre, archive_base, genre_base, sizes = [], [], [], [], []
        for index in selected:
            seed = films.iloc[index]
            seed_labels = genres(seed.genres)
            result = similar(seed.title, limit=10)
            scores = [movie['similarity_score'] for movie in result['similar_movies']]
            assert scores == sorted(scores, reverse=True), seed.title
            assert result['query_movie']['movieId'] not in {m['movieId'] for m in result['similar_movies']}
            assert all(m['movieId'] in year for m in result['similar_movies'])
            ordering_checks += 1
            labels = [genres(movie['genres']) for movie in result['similar_movies']]
            sizes.append(len(labels))
            exact.append(mean(genre in tags for tags in labels))
            any_genre.append(mean(bool(seed_labels & tags) for tags in labels))
            archive_base.append((len(set().union(*(all_indices_by_genre[label] for label in seed_labels))) - 1)
                                / (len(films) - 1))
            genre_base.append((len(all_indices_by_genre[genre]) - 1) / (len(films) - 1))
        report['genre_benchmark'][genre] = {
            'seeds': len(selected), 'exact_genre_top10': round(mean(exact), 4),
            'baseline_exact_genre': round(mean(genre_base), 4),
            'any_genre_top10': round(mean(any_genre), 4), 'baseline_any_genre': round(mean(archive_base), 4),
            'returned': sum(sizes),
        }

    for lower, upper, deck in session_decks[::8]:
        like_count = [1, 3, 5, 10][len(report['mixed_seeds']) % 4]
        liked = deck[:like_count]
        report['mixed_seeds'].append({
            'min_year': lower, 'max_year': upper, 'liked': liked, 'passed': deck[like_count:],
            'responses': {movie['title']: similar(movie['title'], lower, upper) for movie in liked},
        })

    report['checks'] = {'ordered_non_self_local_lists': ordering_checks, 'valid_cold_start_draws': len(session_decks),
                        'cold_start_genre_occurrences': dict(primary_counts)}
    output = OUT / 'backend.json'
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    for key in ('data', 'decks', 'api_edges', 'genre_benchmark', 'checks'):
        print(f'{key}: {report[key]}')
    print(f'Full audit data: {output.relative_to(ROOT)}')


if __name__ == '__main__':
    main_audit()
