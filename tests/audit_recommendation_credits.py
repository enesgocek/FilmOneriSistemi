"""Compare the first listed actor of four seeds to the top ten suggestions' cast."""

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen
import json
import os
import sys

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import main  # Loads the project's existing environment configuration.
from scripts.setup_catalog_ratings import MOVIELENS_URL

OUT = ROOT / 'tmp' / 'recommendation-audit'
SEEDS = ('Matrix, The (1999)', 'Forrest Gump (1994)', 'Devil Wears Prada, The (2006)', 'Interstellar (2014)')


def main_audit():
    key = os.environ.get('TMDB_API_KEY', '').strip()
    if not key:
        raise SystemExit('TMDB_API_KEY is needed for the optional credits comparison.')

    results = json.loads((OUT / 'backend.json').read_text(encoding='utf-8'))['curated']
    with urlopen(MOVIELENS_URL + 'links.csv', timeout=20) as stream:
        links = pd.read_csv(stream, usecols=['movieId', 'tmdbId']).dropna().astype(int)
    id_to_tmdb = dict(zip(links.movieId, links.tmdbId))
    selections = {title: (results[title]['query_movie'], results[title]['similar_movies'][:10]) for title in SEEDS}
    ids = {movie['movieId'] for seed, suggestions in selections.values() for movie in [seed, *suggestions]}

    def credits(movie_id):
        tmdb_id = id_to_tmdb.get(movie_id)
        if tmdb_id is None:
            return movie_id, {'error': 'no_tmdb_mapping'}
        url = f'https://api.themoviedb.org/3/movie/{tmdb_id}/credits?' + urlencode({'api_key': key})
        try:
            with urlopen(url, timeout=10) as stream:
                data = json.load(stream)
        except (HTTPError, URLError, TimeoutError, ValueError) as error:
            # Do not print URLs or exception bodies containing authentication details.
            return movie_id, {'error': getattr(error, 'code', type(error).__name__)}
        cast = sorted(data.get('cast', []), key=lambda actor: actor.get('order', 10000))
        return movie_id, {'cast': [{'id': actor['id'], 'name': actor['name']} for actor in cast], 'tmdb_id': tmdb_id}

    with ThreadPoolExecutor(max_workers=4) as executor:
        movie_credits = dict(executor.map(credits, sorted(ids)))

    report = {}
    for title, (seed, suggestions) in selections.items():
        seed_cast = movie_credits[seed['movieId']].get('cast')
        if not seed_cast:
            report[title] = {'error': 'missing_seed_cast'}
            continue
        lead = seed_cast[0]
        rows = []
        for rank, movie in enumerate(suggestions, 1):
            entry = movie_credits[movie['movieId']]
            cast = entry.get('cast')
            if not cast:
                rows.append({'rank': rank, 'title': movie['title'], 'error': entry.get('error', 'empty_cast')})
                continue
            rows.append({'rank': rank, 'title': movie['title'], 'tmdb_id': entry['tmdb_id'],
                         'lead_in_top_three': lead['id'] in {person['id'] for person in cast[:3]},
                         'lead_in_cast': lead['id'] in {person['id'] for person in cast}})
        verified = [row for row in rows if 'error' not in row]
        report[title] = {'actor': lead['name'], 'checked': len(verified),
                         'lead_in_top_three': sum(row['lead_in_top_three'] for row in verified),
                         'lead_in_cast': sum(row['lead_in_cast'] for row in verified), 'rows': rows}

    (OUT / 'credits.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    for title, result in report.items():
        print(title, {key: value for key, value in result.items() if key != 'rows'})


if __name__ == '__main__':
    main_audit()
