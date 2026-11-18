"""Local catalogue paging/search contracts, without loading the full dataset."""
import unittest
import pandas as pd
from fastapi import HTTPException
import main


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.saved = main.DATA_STORE.copy()
        rows = [{"movieId": i + 1, "title": f"Arşiv Film {i:03} (2000)",
                 "genres": "Drama|Adventure", "overview": "Local overview", "year": 2000}
                for i in range(65)]
        rows += [{"movieId": 100 + i, "title": f"Other {i:03}",
                  "genres": "", "overview": "", "year": 1970} for i in range(40)]
        rows.append({"movieId": 999, "title": "Literal [.*] (1999)",
                     "genres": "", "overview": "", "year": 1999})
        movies = pd.DataFrame(rows)
        main.DATA_STORE.update(df_movies=movies, search_titles=movies.title.map(main.normalize_catalog_query), is_loaded=True)

    def tearDown(self):
        main.DATA_STORE.clear()
        main.DATA_STORE.update(self.saved)

    def test_all_records_exactly_once(self):
        pages = [main.get_all_movies(page=p, limit=30, q="") for p in range(1, 5)]
        self.assertEqual([len(p['movies']) for p in pages], [30, 30, 30, 16])
        ids = [movie['movieId'] for page in pages for movie in page['movies']]
        self.assertEqual(len(set(ids)), 106)
        self.assertEqual(set(ids), set(main.DATA_STORE['df_movies'].movieId))
        self.assertTrue(all(p['total_movies'] == 106 and p['total_pages'] == 4 for p in pages))

    def test_search_is_paginated_over_entire_local_dataset(self):
        result = main.get_all_movies(page=3, limit=30, q="  ARŞİV  ")
        self.assertEqual((result['total_movies'], result['total_pages']), (65, 3))
        self.assertEqual(len(result['movies']), 5)
        self.assertEqual(result['movies'][0]['movieId'], 61)
        self.assertEqual(main.get_all_movies(page=1, limit=30, q='other')['total_movies'], 40)
        self.assertEqual(main.get_all_movies(page=1, limit=30, q='arsiv')['total_movies'], 65)

    def test_search_literal_characters(self):
        result = main.get_all_movies(page=1, limit=30, q='[.*]')
        self.assertEqual([m['movieId'] for m in result['movies']], [999])

    def test_ratings_are_sorted_across_pages_with_unrated_movies_last(self):
        movies = main.DATA_STORE['df_movies']
        movies['tmdb_rating'] = movies['movieId'].map({1: 6.2, 35: 9.3, 64: 9.3, 139: 8.1})
        movies['tmdb_votes'] = movies['movieId'].map({1: 8, 35: 10, 64: 75, 139: 500}).fillna(0)
        first = main.get_all_movies(page=1, limit=2, q='', sort='rating-desc')
        second = main.get_all_movies(page=2, limit=2, q='', sort='rating-desc')
        self.assertTrue(first['rating_available'])
        self.assertEqual([m['movieId'] for m in first['movies'] + second['movies']], [64, 35, 139, 1])
        low = main.get_all_movies(page=1, limit=5, q='', sort='rating-asc')
        self.assertEqual([m['tmdb_rating'] for m in low['movies']], [6.2, 8.1, 9.3, 9.3, None])

    def test_filters_intersect_with_search_before_pagination(self):
        movies = main.DATA_STORE['df_movies']
        movies['tmdb_rating'] = movies['movieId'].map({1: 7.1, 2: 8.5, 64: 9.2, 100: 9.7})
        movies['tmdb_votes'] = 5
        movies.loc[movies['movieId'] == 2, 'genres'] = 'DramaSpecial'
        result = main.get_all_movies(
            page=1, limit=1, q='arsiv', genre='Drama', year=2000, min_rating=7, sort='rating-desc'
        )
        self.assertEqual((result['total_movies'], result['total_pages']), (2, 2))
        self.assertEqual([m['movieId'] for m in result['movies']], [64])

    def test_empty_search_and_out_of_range_pages(self):
        self.assertEqual(main.get_all_movies(page=1, limit=30, q='   ')['total_movies'], 106)
        empty = main.get_all_movies(page=99, limit=30, q='not-in-database')
        self.assertEqual((empty['movies'], empty['page'], empty['total_pages']), ([], 1, 0))
        self.assertEqual(main.get_all_movies(page=99, limit=30, q='other')['page'], 2)

    def test_not_loaded_is_service_unavailable(self):
        main.DATA_STORE['is_loaded'] = False
        with self.assertRaises(HTTPException) as error:
            main.get_all_movies(page=1, limit=30, q='')
        self.assertEqual(error.exception.status_code, 503)


if __name__ == '__main__':
    unittest.main()
