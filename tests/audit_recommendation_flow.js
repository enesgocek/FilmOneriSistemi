/* Exercise the production client with a deterministic session API. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'static', 'app.js'), 'utf8');
const calls = [];
const status = { hidden: true, textContent: '' };
const context = vm.createContext({
    navigator: { userAgent: 'CineFlow audit' },
    document: { documentElement: { style: { setProperty() {} } }, getElementById: () => status },
    window: { innerHeight: 800, innerWidth: 1280, addEventListener() {} },
    URLSearchParams, setTimeout: fn => setTimeout(fn, 0), clearTimeout,
    async fetch(input, options = {}) {
        const url = new URL(input, 'http://cineflow.local');
        const body = options.body ? JSON.parse(options.body) : null;
        calls.push({ url, body, method: options.method });
        const movies = body ? Array.from({ length: 25 }, (_, index) => ({
            movieId: index + (body.previous_ids.length ? 200 : 100),
            title: 'Film ' + index,
            recommendation_rank: index + 1,
        })) : [];
        return { ok: true, json: async () => ({ movies }) };
    },
});

const marker = '// Wait for DOM + scripts';
assert.ok(source.includes(marker));
vm.runInContext(source.replace(marker, 'globalThis.audit = {API, STATE, ColdStartFlow, ViewManager, HomeRenderer}; return; ' + marker),
    context, { filename: 'static/app.js' });
const { API, STATE, ColdStartFlow, ViewManager, HomeRenderer } = context.audit;

async function audit() {
    Object.assign(STATE, { selectedMinYear: 1990, selectedMaxYear: 2010, selectedGenres: ['Action', 'Sci-Fi'],
        likedMovies: [{ movieId: 41 }], passedMovies: [{ movieId: 42 }] });
    await API.getColdStartMovies();
    const query = calls[0].url.searchParams;
    assert.deepEqual(query.getAll('genres'), ['Action', 'Sci-Fi']);
    assert.deepEqual([query.get('min_year'), query.get('max_year'), query.get('count')], ['1990', '2010', '10']);
    const stages = [];
    ViewManager.showTransition = () => stages.push('matching');
    ViewManager.setTransitionStage = stage => stages.push(stage);
    ViewManager.showHome = () => stages.push('home');
    HomeRenderer.animateCards = () => {};
    HomeRenderer.render = async movies => { STATE.currentRecommendations = movies; };
    await ColdStartFlow.transitionToHome();
    assert.deepEqual(stages, ['matching', 'cards', 'ready', 'home']);
    const first = calls[1];
    assert.equal(first.url.pathname, '/session-recommendations');
    assert.equal(first.method, 'POST');
    assert.deepEqual(first.body.liked_ids, [41]);
    assert.deepEqual(first.body.passed_ids, [42]);
    assert.deepEqual(first.body.genres, ['Action', 'Sci-Fi']);
    assert.deepEqual([first.body.min_year, first.body.max_year, first.body.limit], [1990, 2010, 25]);
    assert.deepEqual(first.body.previous_ids, []);
    const previous = Array.from(STATE.currentRecommendations, movie => movie.movieId);
    assert.equal(previous.length, 25);
    await ColdStartFlow.transitionToHome(true);
    assert.deepEqual(calls[2].body.previous_ids, previous);
    assert.deepEqual(calls[2].body.liked_ids, first.body.liked_ids);
    assert.deepEqual(calls[2].body.passed_ids, first.body.passed_ids);
    assert.equal(STATE.currentRecommendations.length, 25);
    assert.equal(status.hidden, true);
    console.log('Deck filters, session payload, 25 cards, and remix verified.');
}

audit().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
