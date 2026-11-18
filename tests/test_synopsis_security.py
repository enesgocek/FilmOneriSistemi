"""Regressions for archive plot selection and credentials kept on the server."""

import json
import os
from io import BytesIO
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch

import pandas as pd
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

import main


PLOT = 'Kate returns to Ohio as police chief and investigates a series of murders.'
PLOT_TR = 'Kate, polis şefi olarak Ohio’ya döner ve bir dizi cinayeti soruşturur.'
REVIEW = 'Kendi adıma söylemek gerekirse filmi çok beğendim. Kesinlikle tavsiye ederim.'


class SynopsisSecurityTests(TestCase):
    def setUp(self):
        rows = pd.DataFrame([
            {'title': 'Amish Murder, An (2013)', 'overview': REVIEW},
            {'title': 'Amish Murder, An (2013)', 'overview': PLOT},
            {'title': 'Another Film (2013)', 'overview': 'I really enjoyed this film and its performances.'},
        ])
        mock = patch.dict(main.DATA_STORE, recommendation_index=SimpleNamespace(by_id={1: 0, 109489: 1, 3: 2}, movies=rows))
        mock.start()
        self.addCleanup(mock.stop)

    def test_film_id_selects_its_own_plot_even_when_title_matches(self):
        with patch.object(main, 'translate_overview', return_value=PLOT_TR) as translate:
            self.assertEqual(main.get_movie_synopsis(109489), {'movieId': 109489, 'language': 'tr', 'text': PLOT_TR})
        translate.assert_called_once_with(PLOT, 'tr')

    def test_reviews_are_excluded_before_translation(self):
        with patch.object(main, 'translate_overview') as translate:
            for movie_id in (1, 3):
                self.assertEqual(main.get_movie_synopsis(movie_id)['text'], '')
        translate.assert_not_called()

    def test_review_from_translation_provider_is_excluded(self):
        with patch.object(main, 'translate_overview', return_value=REVIEW):
            with self.assertRaises(HTTPException) as error:
                main.get_movie_synopsis(109489)
        self.assertEqual(error.exception.status_code, 502)

    def test_unknown_movie_cannot_trigger_translation_or_poster_lookup(self):
        with patch.object(main, 'translate_overview') as translate, patch.object(main, 'urlopen') as upstream:
            for endpoint in (main.get_movie_synopsis, main.get_movie_poster):
                with self.assertRaises(HTTPException) as error:
                    endpoint(999)
                self.assertEqual(error.exception.status_code, 404)
        translate.assert_not_called()
        upstream.assert_not_called()

    def test_poster_endpoint_only_exposes_poster_and_rating(self):
        upstream_body = {'results': [
            {'title': 'An Amish Murder', 'release_date': '2013-01-06', 'poster_path': '/test.jpg',
             'vote_average': 5.8, 'overview': REVIEW, 'other': 'fake-server-token'},
        ]}
        with patch.dict(os.environ, TMDB_API_KEY='fake-server-token'), patch.object(
            main, 'urlopen', return_value=BytesIO(json.dumps(upstream_body).encode())
        ) as upstream:
            self.assertEqual(main.get_movie_poster(109489), {'poster_path': '/test.jpg', 'rating': 5.8})
        self.assertIn('api_key=fake-server-token', upstream.call_args.args[0])
        self.addCleanup(main.lookup_movie_poster.cache_clear)

    def test_demo_recommendations_require_a_configured_token(self):
        valid = HTTPAuthorizationCredentials(scheme='Bearer', credentials='fixture-token')
        invalid = HTTPAuthorizationCredentials(scheme='Bearer', credentials='different-value')
        with patch.dict(os.environ, CINEFLOW_DEMO_TOKEN=''):
            with self.assertRaises(HTTPException) as error:
                main.require_demo_token(valid)
            self.assertEqual(error.exception.status_code, 404)
        with patch.dict(os.environ, CINEFLOW_DEMO_TOKEN='fixture-token'):
            for credentials in (None, invalid):
                with self.assertRaises(HTTPException) as error:
                    main.require_demo_token(credentials)
                self.assertEqual(error.exception.status_code, 401)
            self.assertIsNone(main.require_demo_token(valid))
