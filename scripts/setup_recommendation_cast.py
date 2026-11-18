"""Import top-billed TMDB cast into the local CineFlow catalogue."""

import ast
import json
from pathlib import Path
from urllib.request import urlopen

import pandas as pd

from setup_catalog_ratings import MOVIELENS_URL

DATA = Path(__file__).resolve().parents[1] / 'data'
CREDITS_URL = (
    'https://huggingface.co/datasets/gaygaaa/TheMoviesDataset/'
    'resolve/287abcb9999f332e13d93b17c9b0352b96875941/credits.csv'
)


def main():
    local = pd.read_pickle(DATA / 'movies_with_embeddings.pkl')[['movieId', 'title']]
    with urlopen(MOVIELENS_URL + 'links.csv', timeout=30) as response:
        links = pd.read_csv(response, usecols=['movieId', 'tmdbId']).dropna().astype(int)
    with urlopen(MOVIELENS_URL + 'movies.csv', timeout=30) as response:
        reference = pd.read_csv(response, usecols=['movieId', 'title'])
    matched = local.merge(reference, on='movieId', suffixes=('_local', '_reference'))
    same_title = matched['title_local'].str.strip().str.casefold().eq(matched['title_reference'].str.strip().str.casefold())
    links = links[links['movieId'].isin(matched.loc[same_title, 'movieId'])]
    target_ids = set(links.tmdbId)
    credits = {}
    print(f'Checking cast for {len(target_ids):,} verified TMDB movie IDs…', flush=True)
    with urlopen(CREDITS_URL, timeout=60) as response:
        for chunk in pd.read_csv(response, usecols=['id', 'cast'], chunksize=2000):
            for row in chunk[chunk.id.isin(target_ids)].itertuples(index=False):
                if row.id in credits:
                    continue
                try:
                    cast = ast.literal_eval(row.cast)
                except (ValueError, SyntaxError):
                    continue
                actors = sorted(cast, key=lambda credit: credit.get('order', 999))
                leading = {}
                for actor in actors:
                    if isinstance(actor.get('id'), int) and isinstance(actor.get('name'), str):
                        leading.setdefault(actor['id'], actor['name'])
                        if len(leading) == 3:
                            break
                if leading:
                    credits[row.id] = list(leading.items())

    indexed = {int(row.movieId): credits[row.tmdbId] for row in links.itertuples(index=False) if row.tmdbId in credits}
    target = DATA / 'recommendation_cast.json'
    temporary = target.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(indexed, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    temporary.replace(target)
    print(f'Indexed {len(indexed):,} local films with cast credits.', flush=True)


if __name__ == '__main__':
    main()
