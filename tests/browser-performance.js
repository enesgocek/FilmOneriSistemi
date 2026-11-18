/* Deterministic browser fixture. Loaded ONLY by performance_server.py. */
(() => {
    const nativeFetch = window.fetch.bind(window);
    const paths = ['1uzej9M9Aylgve16AW7YOV17jqy.jpg', 'wNK64eTwwU8Io3gvGbWM4rZGUUL.jpg',
        'bCp4647kgNVj7OPi64afNeOPCq7.jpg', 'dGv3oVnO03RoCLSCt4DVThbpO5q.jpg',
        'suRf59zRu1h8Zq4Gxekn6UiLGaM.jpg', '7sAKZCkcs27bTo6YsaJgHjyUTwV.jpg',
        'rbf4ygVXGgjdPam70Stlbcu67Dl.jpg', 'suUhtPpuB2DVXuEUVOF9aiLcj5N.jpg',
        'ercbL2Oavgu296aGwKsdFofKTTW.jpg', 'idqvLBmlEHUITMnQ0EJ6Yb5TpVw.jpg'];
    const movies = Array.from({length: 40}, (_, i) => ({movieId: i + 1,
        title: `Film ${i + 1} (2000)`, genres: 'Adventure|Drama',
        overview: 'Bir yolculuk, beklenmedik karşılaşmalar ve hayatı değiştiren seçimler üzerine bir film.',
        similarity_score: 0.95 - i / 100}));
    const reply = data => Promise.resolve(new Response(JSON.stringify(data), {headers: {'Content-Type': 'application/json'}}));
    window.fetch = (input, options) => {
        const url = new URL(input, location.href);
        if (url.pathname === '/api/config') return reply({TMDB_API_KEY: 'fixture'});
        if (url.pathname === '/health') return reply({total_movies: 46528, total_users: 162541});
        if (url.pathname === '/api/movie-posters') {
            const index = Number(url.searchParams.get('movie_id')) - 1;
            return reply({poster_path: '/' + paths[index % paths.length], rating: 5 + (index % 10) / 2});
        }
        const synopsis = url.pathname.match(/^\/movies\/(\d+)\/synopsis$/);
        if (synopsis) {
            const movieId = Number(synopsis[1]);
            return reply({movieId, language: url.searchParams.get('language'), text: movies[movieId - 1].overview});
        }
        if (url.pathname === '/cold-start') return reply({movies: movies.slice(0, 10)});
        if (url.pathname === '/similar') return reply({similar_movies: movies.slice(10)});
        if (url.pathname === '/session-recommendations') {
            const {limit, liked_ids} = JSON.parse(options.body);
            const source = movies.find(movie => movie.movieId === liked_ids[0]);
            return reply({movies: movies.slice(10, 10 + limit).map((movie, index) => ({
                ...movie, recommendation_rank: index + 1,
                reasons: source ? [{kind: 'plot', source_movie_id: source.movieId, source_title: source.title}]
                    : [{kind: 'discovery'}],
            }))});
        }
        if (url.pathname === '/api/translate') {
            const {q, target = 'tr'} = JSON.parse(options.body);
            return reply({translatedText: q, language: target});
        }
        if (url.hostname === 'api.themoviedb.org') {
            const index = Number(url.searchParams.get('query').match(/\d+/)[0]) - 1;
            return reply({results: [{id: index + 1, title: movies[index].title,
                poster_path: '/' + paths[index % paths.length], overview: movies[index].overview,
                vote_average: 5 + (index % 10) / 2}]});
        }
        return nativeFetch(input, options);
    };

    // Detect handler leaks across restart without exposing production internals.
    const listeners = new Map();
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    const relevant = (target, type) => ['btn-pass', 'btn-like', 'card-stack'].includes(target.id)
        && ['click', 'pointerdown'].includes(type);
    EventTarget.prototype.addEventListener = function(type, fn, options) {
        if (relevant(this, type)) {
            const key = `${this.id}:${type}`;
            if (!listeners.has(key)) listeners.set(key, new Set());
            listeners.get(key).add(fn);
        }
        return add.call(this, type, fn, options);
    };
    EventTarget.prototype.removeEventListener = function(type, fn, options) {
        if (relevant(this, type)) listeners.get(`${this.id}:${type}`)?.delete(fn);
        return remove.call(this, type, fn, options);
    };
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    const wait = async (predicate, timeout = 20000) => {
        const end = performance.now() + timeout;
        while (!predicate()) {
            if (performance.now() > end) throw new Error('Timed out waiting for app state');
            await sleep(20);
        }
    };
    const results = {variant: location.pathname.includes('baseline') ? 'baseline' : 'current',
        width: innerWidth, height: innerHeight, dpr: devicePixelRatio, stages: [], checks: {}, errors: []};
    window.addEventListener('error', e => results.errors.push(e.message));
    window.addEventListener('unhandledrejection', e => results.errors.push(String(e.reason)));
    async function measure(name, action, duration) {
        const frames = [];
        const longTasks = [];
        let active = true, previous;
        const observer = new PerformanceObserver(list => longTasks.push(...list.getEntries().map(e => e.duration)));
        observer.observe({type: 'longtask', buffered: false});
        const tick = now => {
            if (!active) return;
            if (previous !== undefined) frames.push(now - previous);
            previous = now;
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        await action();
        await sleep(duration);
        active = false;
        observer.disconnect();
        const sorted = [...frames].sort((a,b) => a-b);
        results.stages.push({name, frames: frames.length,
            meanMs: frames.length ? +(frames.reduce((a,b)=>a+b,0)/frames.length).toFixed(2) : null,
            p95Ms: frames.length ? +sorted[Math.floor(sorted.length * .95)].toFixed(2) : null,
            over33ms: frames.filter(v=>v>33.4).length,
            longTasks: longTasks.length, longTaskMs: +longTasks.reduce((a,b)=>a+b,0).toFixed(2)});
    }

    window.addEventListener('load', async () => {
        try {
            await wait(() => window.__cineflowTest);
            await sleep(350);
            await document.fonts.ready;
            // Warm image cache equally; animation comparison excludes download variability.
            await Promise.all(paths.map(path => {
                const img = new Image(); img.src = 'https://image.tmdb.org/t/p/w500/' + path;
                return img.decode().catch(() => {});
            }));
            const {STATE, DOM, ColdStartFlow: cold, HomeRenderer: home, ViewManager: views} = window.__cineflowTest;
            await measure('portal-and-deck', async () => {
                document.querySelector('.year-card').click();
                const genres = document.getElementById('genre-form');
                if (genres) {
                    await wait(() => document.getElementById('genre-view').classList.contains('view--active'));
                    genres.requestSubmit();
                }
            }, 7800);
            await wait(() => !STATE.isAnimating && DOM.coldStartView.classList.contains('view--active'));
            results.checks.deckCount = DOM.cardStack.children.length;
            results.checks.visibleDeckCount = [...DOM.cardStack.children].filter(c=>getComputedStyle(c).visibility !== 'hidden').length;
            results.checks.postersReady = [...DOM.cardStack.querySelectorAll('img')].every(img=>img.complete && img.naturalWidth>0);
            const front = DOM.cardStack.querySelector('.swipe-card--front');
            await measure('flip', () => cold.executeFlipAnimation(front), 800);
            await wait(()=>!STATE.isAnimating);
            results.checks.flipped = front.classList.contains('is-flipped');
            await measure('flip-back', () => cold.executeFlipAnimation(front), 800);
            await wait(()=>!STATE.isAnimating);
            results.checks.flippedBack = !front.classList.contains('is-flipped');
            front.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, clientX:200, clientY:200, isPrimary:true}));
            document.dispatchEvent(new PointerEvent('pointermove', {clientX:240,clientY:200,isPrimary:true}));
            await sleep(30);
            document.dispatchEvent(new PointerEvent('pointerup', {clientX:240,clientY:200,isPrimary:true}));
            results.checks.snapStartsAtDrag = new DOMMatrix(getComputedStyle(front).transform).m41 > 20;
            await wait(()=>typeof gsap==='undefined' || !gsap.isTweening(front));
            results.checks.snapReturned = Math.abs(new DOMMatrix(getComputedStyle(front).transform).m41) < .5;
            if (cold.onPointerCancel) {
                front.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true,clientX:200,clientY:200,isPrimary:true}));
                document.dispatchEvent(new PointerEvent('pointermove', {clientX:260,clientY:200,isPrimary:true}));
                document.dispatchEvent(new PointerEvent('pointercancel', {isPrimary:true}));
                await wait(()=>typeof gsap==='undefined' || !gsap.isTweening(front));
                results.checks.cancelledDrag = !STATE.isDragging && document.body.style.overflow === ''
                    && Math.abs(new DOMMatrix(getComputedStyle(front).transform).m41) < .5;
            }
            await measure('swipe', () => cold.triggerSwipe('like'), 950);
            await wait(()=>!STATE.isAnimating);
            results.checks.oneDecision = STATE.decisions.length === 1;
            // Drive real transition code and full 30-card recommendation flow.
            await cold.transitionToHome();
            await sleep(2200);
            await measure('recommendation-entrance', async () => {
                home.animateCards();
                await sleep(250);
                results.checks.cssTransformTransitions = DOM.movieGrid.getAnimations({subtree:true})
                    .filter(a => a.transitionProperty === 'transform').length;
            }, 2300);
            results.checks.recommendations = DOM.movieGrid.children.length;
            const nodes = [...DOM.movieGrid.children];
            await measure('sort', () => document.querySelector('[data-sort="rating"]').click(), 2400);
            results.checks.reusedCards = [...DOM.movieGrid.children].every(c=>nodes.includes(c));
            const ratingOrder = [...DOM.movieGrid.querySelectorAll('.rating-value')].map(el=>Number(el.textContent));
            results.checks.ratingOrder = ratingOrder.every((rating,i)=>i===0 || ratingOrder[i-1]>=rating);
            // Interrupt an entrance with another sort, then verify no old parent
            // tween clears the new animation's transition guard.
            document.querySelector('[data-sort="similarity"]').click();
            await sleep(150);
            document.querySelector('[data-sort="rating"]').click();
            await sleep(250);
            results.checks.rapidSortTransitions = DOM.movieGrid.getAnimations({subtree:true})
                .filter(a=>a.transitionProperty==='transform').length;
            await sleep(2400);
            results.checks.rapidSortVisible = [...DOM.movieGrid.children].every(card=>Number(getComputedStyle(card).opacity)===1);
            results.checks.barsAtTarget = [...DOM.movieGrid.querySelectorAll('.similarity-bar__fill')]
                .every(el=>Math.abs(parseFloat(el.style.width)-Number(el.dataset.target)) < .1
                    && Math.abs(new DOMMatrix(getComputedStyle(el).transform).a-1) < .01);
            // Rebind exactly as the restart lifecycle does.
            for (let i=0;i<3;i++) { cold.unbindEvents(); cold.bindEvents(); }
            results.checks.handlerCounts = Object.fromEntries([...listeners].map(([key,set])=>[key,set.size]));
            results.checks.uniqueHandlers = [...listeners.values()].every(set=>set.size===1);
            home.showModal(STATE.currentRecommendations[0]);
            await sleep(500);
            results.checks.modalVisible = !document.getElementById('hologram-modal').classList.contains('hidden');
            document.querySelector('.hologram-modal__close').click();
            results.checks.modalClosed = document.getElementById('hologram-modal').classList.contains('hidden');
            document.getElementById('btn-restart').click();
            await wait(()=>document.getElementById('onboarding-view').classList.contains('view--active'));
            document.querySelector('.year-card').click();
            await wait(()=>DOM.coldStartView.classList.contains('view--active') && !STATE.isAnimating);
            results.checks.restartResetsDecisions = STATE.decisions.length === 0 && STATE.currentCardIndex === 0;
            results.checks.restartHandlers = Object.fromEntries([...listeners].map(([key,set])=>[key,set.size]));
            results.checks.restartUniqueHandlers = [...listeners.values()].every(set=>set.size===1);
            results.checks.restartCardsVisible = [...DOM.cardStack.children]
                .filter(c=>getComputedStyle(c).visibility !== 'hidden' && getComputedStyle(c).display !== 'none').length === 3;
            await nativeFetch('/results', {method:'POST', body:JSON.stringify(results)});
            const output = document.createElement('pre');
            output.id = 'test-results'; output.textContent = JSON.stringify(results,null,2);
            output.style.cssText = 'position:relative;z-index:10000;background:#111;color:#fff;padding:24px;white-space:pre-wrap';
            document.body.append(output);
            document.title = 'Tests complete — ' + results.variant;
        } catch (error) {
            results.errors.push(String(error));
            await nativeFetch('/results', {method:'POST',body:JSON.stringify(results)});
            const output = document.createElement('pre'); output.id='test-results';
            output.textContent=JSON.stringify(results,null,2); document.body.append(output);
            document.title = 'Tests failed — ' + results.variant;
        }
    });
})();
