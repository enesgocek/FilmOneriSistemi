"""Regression coverage for session ranking and year/genre card selection."""

import unittest

import numpy as np
import pandas as pd
from fastapi import HTTPException

import main
from recommendation_engine import RecommendationIndex


class SessionRecommendationsTests(unittest.TestCase):
    def setUp(self):
        self.saved = main.DATA_STORE.copy()
        rows = [
            {'movieId': 1, 'title': 'Film A', 'genres': 'Action|Sci-Fi', 'year': 1999},
            {'movieId': 2, 'title': 'Film B', 'genres': 'Drama|Romance', 'year': 1997},
            {'movieId': 3, 'title': 'Geçilen film', 'genres': 'Action', 'year': 1999},
            {'movieId': 4, 'title': 'Film A', 'genres': 'Action|Sci-Fi', 'year': 1999},
        ]
        vectors = [[1, 0], [0, 1], [0.2, 0.8], [1, 0]]
        self.cast = {1: {70: 'Örnek oyuncu'}, 2: {90: 'Diğer oyuncu'}}
        for i in range(5, 45):
            action = i % 2 != 0
            rows.append({'movieId': i, 'title': f'Aday {i}', 'genres': 'Action|Sci-Fi' if action else 'Drama',
                         'year': 1998 if i < 37 else 2015})
            signal = (0.80 + i / 1000, 0.39 + i / 2000)
            vectors.append(signal if action else signal[::-1])
            self.cast[i] = self.cast[1 if action else 2]
        movies = pd.DataFrame(rows).assign(overview='Örnek film konusu.')
        embeddings = np.asarray(vectors, dtype=np.float32)
        embeddings /= np.linalg.norm(embeddings, axis=1, keepdims=True)
        self.index = RecommendationIndex(movies, embeddings, self.cast)
        main.DATA_STORE.update(is_loaded=True, df_movies=movies, recommendation_index=self.index)

    def tearDown(self):
        main.DATA_STORE.clear()
        main.DATA_STORE.update(self.saved)

    def request(self, **fields):
        return main.get_session_recommendations(main.SessionRecommendations(**fields))['movies']

    def test_identical_likes_in_another_order_keep_same_rank(self):
        first = self.request(liked_ids=[1, 2], passed_ids=[3], variation=42)
        self.assertEqual(len(first), 25)
        self.assertEqual(first, self.request(liked_ids=[2, 1, 1], passed_ids=[3], variation=42))
        self.assertEqual(len({item['movieId'] for item in first}), len(first))
        self.assertFalse({1, 2, 3, 4} & {item['movieId'] for item in first})
        self.assertEqual(sorted(item['recommendation_rank'] for item in first), list(range(1, len(first) + 1)))

    def test_remix_preserves_anchor_and_uses_nearby_candidates(self):
        original = self.request(liked_ids=[1, 2], passed_ids=[3], variation=0)
        remix = self.request(liked_ids=[1, 2], passed_ids=[3], variation=19,
                             previous_ids=[item['movieId'] for item in original])
        self.assertEqual(original[0]['movieId'], remix[0]['movieId'])
        self.assertTrue(set(item['movieId'] for item in remix) - {item['movieId'] for item in original})
        self.assertEqual({reason['kind'] for item in remix for reason in item['reasons']}, {'plot', 'genre', 'cast'})
        for item in remix:
            for reason in item['reasons']:
                if reason['kind'] == 'cast':
                    common = self.cast[item['movieId']].keys() & self.cast[reason['source_movie_id']].keys()
                    self.assertIn(reason['actor'], [self.cast[item['movieId']][actor] for actor in common])

    def test_deck_and_recommendations_respect_combined_filters(self):
        options = {'min_year': 1990, 'max_year': 2000, 'genres': ['Sci-Fi', 'Drama']}
        deck = main.get_cold_start_movies(count=10, **options)['movies']
        self.assertEqual(len(deck), 10)
        for item in deck + self.request(liked_ids=[1, 2], **options):
            self.assertTrue(1990 <= item['year'] <= 2000)
            self.assertTrue(set(item['genres'].split('|')) & {'Sci-Fi', 'Drama'})
        limited = main.get_cold_start_movies(count=20, min_year=2015, max_year=2015, genres=['Drama'])['movies']
        self.assertEqual(len(limited), 4)
        self.assertTrue(all(item['genres'] == 'Drama' for item in limited))
        self.assertEqual(len(self.request(liked_ids=[1], min_year=2015, max_year=2015, genres=['Drama'])), 4)

    def test_weak_matches_fill_25_slots_as_discoveries(self):
        films = self.index.movies.copy()
        films.loc[films.movieId != 1, 'genres'] = 'Drama'
        embeddings = np.tile(np.array([0, 1], dtype=np.float32), (len(films), 1))
        embeddings[0] = [1, 0]
        index = RecommendationIndex(films, embeddings, {})
        discovery = index.recommend([1], [3], genres=['Drama'])
        self.assertEqual(len(discovery), 25)
        self.assertTrue(all(movie['reasons'] == [{'kind': 'discovery'}] for movie in discovery))

    def test_all_passes_produce_honest_unseen_discovery(self):
        discovery = self.request(passed_ids=[1, 2, 3], genres=['Sci-Fi'])
        self.assertTrue(discovery)
        for item in discovery:
            self.assertEqual(item['reasons'], [{'kind': 'discovery'}])
            self.assertNotIn('similarity_score', item)
            self.assertNotIn(item['movieId'], {1, 2, 3, 4})

    def test_invalid_filters_and_decisions_return_validation_error(self):
        for fields in ({'genres': ['bad']}, {'min_year': 2020, 'max_year': 1990},
                       {'liked_ids': [1000]}, {'liked_ids': [1], 'passed_ids': [1]}):
            with self.subTest(fields=fields), self.assertRaises(HTTPException) as error:
                self.request(**fields)
            self.assertEqual(error.exception.status_code, 422)
        self.assertEqual(main.get_cold_start_movies(count=10, min_year=2022, max_year=2026)['movies'], [])


if __name__ == '__main__':
    unittest.main()
