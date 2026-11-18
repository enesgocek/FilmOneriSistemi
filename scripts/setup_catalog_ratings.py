"""Build a local TMDB rating index for the existing MovieLens movie IDs."""

from pathlib import Path
from urllib.request import urlopen

import pandas as pd


DATA_DIR = Path(__file__).resolve().parents[1] / 'data'
# Mirror of the MovieLens 25M CSVs. Only film IDs and titles are read.
MOVIELENS_URL = (
    'https://huggingface.co/datasets/cephcyn/2026_01_22_datasets/'
    'resolve/6cc5d468f06f36436b6be810ba89ac48b8b633b6/movielens_25m/ml-25m/'
)
TMDB_URL = (
    'https://huggingface.co/datasets/ada-datadruids/full_tmdb_movies_dataset/'
    'resolve/13ba9f3a87c60eaa07b235e1cfd2e16cc1c9105c/TMDB_movie_dataset_v11.csv'
)


def main():
    local = pd.read_pickle(DATA_DIR / 'movies_with_embeddings.pkl')[['movieId', 'title']]
    print('Downloading MovieLens ID mapping…', flush=True)
    with urlopen(MOVIELENS_URL + 'links.csv', timeout=30) as response:
        links = pd.read_csv(response, usecols=['movieId', 'tmdbId']).dropna().astype('int64')
    with urlopen(MOVIELENS_URL + 'movies.csv', timeout=30) as response:
        titles = pd.read_csv(response, usecols=['movieId', 'title'])
    checked = local.merge(titles, on='movieId', suffixes=('_local', '_reference'))
    same_title = checked['title_local'].str.strip().str.casefold() == checked['title_reference'].str.strip().str.casefold()
    links = links[links['movieId'].isin(checked.loc[same_title, 'movieId'])]
    print(f'Reading TMDB rating snapshot for {len(links):,} local movies…', flush=True)
    known_ids = set(links['tmdbId'])
    with urlopen(TMDB_URL, timeout=60) as response:
        chunks = pd.read_csv(response, usecols=['id', 'vote_average', 'vote_count'], chunksize=75_000)
        ratings = pd.concat(chunk[chunk['id'].isin(known_ids)] for chunk in chunks)
    ratings = ratings[ratings['vote_average'].between(0, 10) & (ratings['vote_count'] > 0)]
    ratings = ratings.sort_values('vote_count', ascending=False).drop_duplicates('id')
    ratings = links.merge(ratings, left_on='tmdbId', right_on='id', validate='many_to_one')
    ratings = ratings.rename(columns={'vote_average': 'tmdb_rating', 'vote_count': 'tmdb_votes'})
    ratings['tmdb_rating'] = ratings['tmdb_rating'].round(1)

    target = DATA_DIR / 'catalog_tmdb_ratings.csv'
    prepared = target.with_suffix('.csv.tmp')
    ratings[['movieId', 'tmdb_rating', 'tmdb_votes']].sort_values('movieId').to_csv(prepared, index=False)
    prepared.replace(target)
    print(f'Indexed {len(ratings):,} local movies with a TMDB score.', flush=True)


if __name__ == '__main__':
    main()
