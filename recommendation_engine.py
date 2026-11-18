"""Rank local films from a single CineFlow swipe session."""

from collections import defaultdict
import json
from pathlib import Path
import random

import numpy as np


GENRES = (
    'Action', 'Adventure', 'Animation', 'Children', 'Comedy', 'Crime', 'Documentary',
    'Drama', 'Fantasy', 'Film-Noir', 'Horror', 'Musical', 'Mystery', 'Romance',
    'Sci-Fi', 'Thriller', 'War', 'Western',
)
CAST_PATH = Path(__file__).resolve().parent / 'data' / 'recommendation_cast.json'
KINDS = ('plot', 'cast', 'genre')


def load_cast():
    if not CAST_PATH.is_file():
        return {}
    try:
        data = json.loads(CAST_PATH.read_text(encoding='utf-8'))
        return {
            int(movie): {int(actor): name for actor, name in actors[:3] if isinstance(name, str) and name.strip()}
            for movie, actors in data.items()
        }
    except (OSError, ValueError, TypeError, AttributeError):
        print('[WARN] Could not read the recommendation cast index.')
        return {}


class RecommendationIndex:
    def __init__(self, movies, embeddings, cast):
        self.movies = movies
        self.embeddings = embeddings
        self.ids = movies.movieId.to_numpy()
        self.by_id = {int(movie): i for i, movie in enumerate(self.ids)}
        self.titles = movies.title.fillna('').tolist()
        self.title_keys = np.array([title.strip().casefold() for title in self.titles])
        self.years = movies.year.to_numpy()
        self.genre_index = {genre: i for i, genre in enumerate(GENRES)}
        recognized = set(GENRES)
        self.genres = [set(value.split('|')) & recognized for value in movies.genres]
        self.genre_matrix = np.array([[genre in tags for genre in GENRES] for tags in self.genres], dtype=np.float32)
        self.genre_counts = self.genre_matrix.sum(axis=1)
        self.cast = {self.by_id[mid]: actors for mid, actors in cast.items() if mid in self.by_id and actors}
        self.actor_films = defaultdict(list)
        for movie, actors in self.cast.items():
            for position, actor in enumerate(actors):
                self.actor_films[actor].append((movie, 1 - 0.12 * position))
        self.actor_films = {
            actor: (np.array([movie for movie, _ in roles]), np.array([weight for _, weight in roles]))
            for actor, roles in self.actor_films.items()
        }
        self.quality = np.full(len(movies), 0.65, dtype=np.float32)
        if 'tmdb_rating' in movies and 'tmdb_votes' in movies:
            rating, votes = movies.tmdb_rating.fillna(6.5).to_numpy(), movies.tmdb_votes.to_numpy()
            self.quality = ((rating * votes + 6.5 * 80) / (votes + 80) / 10).astype(np.float32)

    def eligible(self, min_year=None, max_year=None, genres=()):
        mask = np.ones(len(self.ids), dtype=bool)
        if min_year is not None:
            mask &= self.years >= min_year
        if max_year is not None:
            mask &= (self.years > 0) & (self.years <= max_year)
        if genres:
            columns = [self.genre_index[genre] for genre in genres]
            mask &= self.genre_matrix[:, columns].any(axis=1)
        return mask

    def _actors_for(self, movie):
        return self.cast.get(movie, {})

    def _cast_scores(self, seed):
        scores = np.zeros(len(self.ids), dtype=np.float32)
        for position, actor in enumerate(self._actors_for(seed)):
            movies, weights = self.actor_films[actor]
            scores[movies] = np.maximum(scores[movies], np.minimum(weights, 1 - 0.12 * position))
        return scores

    @staticmethod
    def _pool(score, mask):
        candidates = np.flatnonzero(mask)
        ranked = candidates[np.argsort(-score[candidates], kind='stable')[:36]]
        if not ranked.size:
            return []
        minimum = score[ranked[0]] - 0.14
        return [(int(movie), float(score[movie])) for movie in ranked if score[movie] >= minimum]

    def _reason(self, kind, seed, movie):
        reason = {'kind': kind, 'source_movie_id': int(self.ids[seed]), 'source_title': self.titles[seed]}
        if kind == 'cast':
            shared = self._actors_for(movie)
            reason['actor'] = next(name for actor, name in self._actors_for(seed).items() if actor in shared)
        elif kind == 'genre':
            reason['genres'] = sorted(self.genres[movie] & self.genres[seed])
        return reason

    def recommend(self, liked_ids, passed_ids, *, min_year=None, max_year=None, genres=(),
                  variation=0, previous_ids=(), limit=25):
        liked = [self.by_id[mid] for mid in sorted(set(liked_ids))]
        passed = [self.by_id[mid] for mid in sorted(set(passed_ids))]
        eligible = self.eligible(min_year, max_year, genres)
        seen = set(self.title_keys[liked + passed])
        eligible &= ~np.isin(self.title_keys, list(seen))
        target = limit
        rng = random.Random(variation)
        previous = set(previous_ids)
        chosen = []

        def add(movie, reasons):
            chosen.append((movie, reasons))
            seen.add(self.title_keys[movie])

        def take(pool):
            available = []
            for movie, score in pool:
                if self.title_keys[movie] not in seen:
                    available.append((movie, score))
                    if len(available) == 6:
                        break
            if not available:
                return None
            nearby = [movie for movie, score in available if score >= available[0][1] - 0.045]
            fresh = [movie for movie in nearby if int(self.ids[movie]) not in previous]
            return rng.choice(fresh or nearby)

        def backfill(score):
            if len(chosen) == target:
                return self._serialize(chosen)
            rest = np.flatnonzero(eligible & ~np.isin(self.title_keys, list(seen)))
            ranked = rest[np.argsort(-score[rest], kind='stable')]
            pool = [(int(movie), float(score[movie])) for movie in ranked]
            while len(chosen) < target:
                movie = take(pool)
                if movie is None:
                    break
                add(movie, [{'kind': 'discovery'}])
            return self._serialize(chosen)

        if not liked:
            buckets = list(genres or GENRES)
            rng.shuffle(buckets)
            pools = [self._pool(self.quality, eligible & (self.genre_matrix[:, self.genre_index[genre]] > 0))
                     for genre in buckets]
            pools.append(self._pool(self.quality, eligible))
            while len(chosen) < target:
                before = len(chosen)
                for pool in pools:
                    movie = take(pool)
                    if movie is not None:
                        add(movie, [{'kind': 'discovery'}])
                    if len(chosen) == target:
                        break
                if len(chosen) == before:
                    break
            return backfill(self.quality)

        topic = np.clip(self.embeddings[liked] @ self.embeddings.T, 0, 1)
        shared = self.genre_matrix[liked] @ self.genre_matrix.T
        totals = self.genre_counts[liked, None] + self.genre_counts[None, :] - shared
        genre_scores = shared / np.maximum(totals, 1)
        affinity = topic.max(axis=0)
        penalty = 0
        if passed:
            skipped = np.clip(self.embeddings[passed] @ self.embeddings.T, 0, 1).max(axis=0)
            # A skip is weak feedback. Penalize only a clearly stronger match to it.
            penalty = 0.16 * np.maximum(0, skipped - np.maximum(0.4, affinity + 0.06))
        context = 0.07 * topic.mean(axis=0) + 0.05 * self.quality - penalty
        pools = {}
        for row, seed in enumerate(liked):
            actors = self._cast_scores(seed)
            pools['plot', seed] = self._pool(
                0.78 * topic[row] + 0.15 * genre_scores[row] + context,
                eligible & (topic[row] >= 0.32),
            )
            pools['cast', seed] = self._pool(
                0.63 * actors + 0.20 * topic[row] + 0.10 * genre_scores[row] + context,
                eligible & (actors > 0),
            )
            pools['genre', seed] = self._pool(
                0.65 * genre_scores[row] + 0.28 * topic[row] + context,
                eligible & (shared[row] > 0) & (topic[row] >= 0.24),
            )

        def add_match(kind, seed, movie):
            reasons = [self._reason(kind, seed, movie)]
            for other_kind in KINDS:
                if other_kind == kind:
                    continue
                matches = [(score, other_seed) for other_seed in liked
                           for index, score in pools[other_kind, other_seed][:12] if index == movie]
                if matches:
                    _, strongest = max(matches)
                    reasons.append(self._reason(other_kind, strongest, movie))
            add(movie, reasons)

        # Keep the best topic match across mixes. Rotate the other qualified slots.
        anchor = max(((pool[0][1], seed, pool[0][0]) for (kind, seed), pool in pools.items()
                      if kind == 'plot' and pool), default=None)
        if anchor:
            _, seed, movie = anchor
            add_match('plot', seed, movie)

        order = list(KINDS)
        seeds = liked[:]
        rng.shuffle(order)
        rng.shuffle(seeds)
        slots = [(order[(round_no + slot_no) % len(order)], seed)
                 for round_no in range(len(order)) for slot_no, seed in enumerate(seeds)]
        first_round = [slot for slot in slots if not anchor or slot != ('plot', anchor[1])]
        for round_no in range(target + 1):
            before = len(chosen)
            for kind, seed in first_round if round_no == 0 else slots:
                if len(chosen) == target:
                    break
                movie = take(pools[kind, seed])
                if movie is not None:
                    add_match(kind, seed, movie)
            if len(chosen) == target or (round_no and len(chosen) == before):
                break
        return backfill(0.85 * affinity + context)

    def _serialize(self, chosen):
        result = []
        for rank, (index, reasons) in enumerate(chosen, 1):
            row = self.movies.iloc[index]
            result.append({'movieId': int(row.movieId), 'title': row.title, 'genres': row.genres,
                           'overview': row.overview, 'year': int(row.year), 'recommendation_rank': rank,
                           'reasons': reasons})
        return result
