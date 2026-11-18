/**
 * CineFlow — Antigravity Swipe & Recommendation Engine
 * =========================================================
 * Cold Start: Tinder-style swipe cards → Home: Personalized recommendations
 */

(function () {
    'use strict';

    // ============================================
    // Configuration
    // ============================================
    const CONFIG = {
        TMDB_IMG_BASE: 'https://image.tmdb.org/t/p/w500',
        SWIPE_THRESHOLD: 0.30, // 30% of card width
        MAX_ROTATION: 15, // degrees
        HOME_MOVIE_COUNT: 25,
        COLD_START_COUNT: 10,
    };

    // ============================================
    // Cihaz Yetenek Algılama (Graceful Degradation)
    // ============================================
    const DEVICE = (function detectDevice() {
        const ua = navigator.userAgent;
        const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
        const isIOS = /iPhone|iPad|iPod/i.test(ua);

        // iOS sürüm numarasını çıkar (örn. "iPhone OS 13_4" → 13)
        const iosVersionMatch = ua.match(/OS (\d+)_/);
        const iosVersion = iosVersionMatch ? parseInt(iosVersionMatch[1], 10) : 99;

        // Keep the existing legacy Safari compatibility path. Screen size and
        // CPU core count do not establish GPU capability on modern devices.
        const isLowEndIOS = isIOS && iosVersion <= 13;
        const isLowEnd = isLowEndIOS;

        // HTML köküne sınıf ekle → CSS tarafı bu sınıfa göre graceful degradation uygular
        if (isLowEnd)  document.documentElement.classList.add('low-end-device');
        if (isMobile)  document.documentElement.classList.add('is-mobile');
        if (isIOS)     document.documentElement.classList.add('is-ios');

        return { isMobile, isIOS, iosVersion, isLowEnd };
    })();

    // ============================================
    // iOS Safari Viewport Yüksekliği Düzeltmesi
    // ============================================
    // iOS Safari'de URL bar gösterilip gizlendiğinde 100vh değeri değişmez.
    // --vh CSS değişkeni programatik olarak güncellenerek UI zıplaması önlenir.
    function setViewportHeight() {
        const vh = window.innerHeight * 0.01;
        document.documentElement.style.setProperty('--vh', `${vh}px`);
    }
    setViewportHeight();
    // resize yerine visualViewport kullan — iOS URL bar geçişlerini yakalar
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', setViewportHeight, { passive: true });
    } else {
        window.addEventListener('resize', setViewportHeight, { passive: true });
    }

    // ============================================
    // State
    // ============================================
    const STATE = {
        selectedMinYear: null,
        selectedMaxYear: null,
        selectedGenres: [],
        coldStartMovies: [],
        currentCardIndex: 0,
        likedMovies: [],
        passedMovies: [],
        decisions: [], // 'like' | 'pass' per index
        isDragging: false,
        startX: 0,
        currentX: 0,
        tmdbCache: {}, // title -> poster_path
    };

    // ============================================
    // DOM References
    // ============================================
    const DOM = {};

    // Decode before an entrance, without trapping the interface on a broken image.
    async function preparePoster(img) {
        let timeout;
        const ready = typeof img.decode === 'function'
            ? img.decode().catch(() => {})
            : new Promise(resolve => {
                if (img.complete) return resolve();
                img.addEventListener('load', resolve, { once: true });
                img.addEventListener('error', resolve, { once: true });
            });
        await Promise.race([ready, new Promise(resolve => { timeout = setTimeout(resolve, 8000); })]);
        clearTimeout(timeout);
    }

    // Start decoding as soon as each metadata request completes, then hand the
    // same image to its card. Do not retain detached cards in the metadata cache.
    const pendingPosters = new WeakMap();
    function warmPoster(data) {
        if (!data?.posterUrl || pendingPosters.has(data)) return;
        const img = new Image();
        img.loading = 'eager';
        img.decoding = 'async';
        img.src = data.posterUrl;
        pendingPosters.set(data, { img, ready: preparePoster(img) });
    }

    function takePoster(data, critical) {
        if (critical) warmPoster(data);
        const prepared = pendingPosters.get(data);
        if (prepared) {
            pendingPosters.delete(data);
            return prepared;
        }
        const img = new Image();
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = data.posterUrl;
        return { img, ready: Promise.resolve() };
    }

    async function mapConcurrent(items, limit, callback) {
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const index = next++;
                await callback(items[index], index);
            }
        }));
    }

    function cacheDOMRefs() {
        DOM.coldStartView = document.getElementById('cold-start-view');
        DOM.transitionView = document.getElementById('transition-view');
        DOM.transitionStatus = document.getElementById('transition-status');
        DOM.homeView = document.getElementById('home-view');
        DOM.cardStack = document.getElementById('card-stack');
        DOM.progressDots = document.getElementById('progress-dots');
        DOM.btnPass = document.getElementById('btn-pass');
        DOM.btnLike = document.getElementById('btn-like');
        DOM.movieGrid = document.getElementById('movie-grid');
        DOM.statusDot = document.getElementById('status-dot');
        DOM.statusText = document.getElementById('status-text');
        DOM.statusMovies = document.getElementById('status-movies');
        // FIX: Eksik DOM referansı eklendi — silent error'a yol açıyordu
        DOM.statusUsers = document.getElementById('status-users');
        DOM.btnRestart = document.getElementById('btn-restart');
        DOM.catalogView = document.getElementById('catalog-view');
        DOM.catalogGrid = document.getElementById('catalog-grid');
        DOM.catalogSearch = document.getElementById('catalog-search');
        DOM.catalogStatus = document.getElementById('catalog-status');
    }


    // ============================================
    // API Layer
    // ============================================
    const API = {
        async fetchJSON(url, retries = 2, options = {}) {
            const res = await fetch(url, options);
            // Handle TMDB rate limiting (429)
            if (res.status === 429 && retries > 0) {
                await new Promise(r => setTimeout(r, 1000));
                return this.fetchJSON(url, retries - 1, options);
            }
            if (!res.ok) throw new Error(`API Error: ${res.status}`);
            return res.json();
        },

        getColdStartMovies() {
            const params = new URLSearchParams({count: CONFIG.COLD_START_COUNT});
            if (STATE.selectedMinYear) params.set('min_year', STATE.selectedMinYear);
            if (STATE.selectedMaxYear) params.set('max_year', STATE.selectedMaxYear);
            STATE.selectedGenres.forEach(genre => params.append('genres', genre));
            return this.fetchJSON(`/cold-start?${params}`);
        },

        getSessionRecommendations(previousIds, variation) {
            return this.fetchJSON('/session-recommendations', 1, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    liked_ids: STATE.likedMovies.map(movie => movie.movieId),
                    passed_ids: STATE.passedMovies.map(movie => movie.movieId),
                    genres: STATE.selectedGenres,
                    min_year: STATE.selectedMinYear,
                    max_year: STATE.selectedMaxYear,
                    previous_ids: previousIds,
                    limit: CONFIG.HOME_MOVIE_COUNT,
                    variation,
                }),
            });
        },

        getHealthStatus() {
            return this.fetchJSON('/health');
        },

        getCatalog(page, query, filters, signal) {
            const params = new URLSearchParams({ page, limit: 30, q: query, ...filters });
            return this.fetchJSON(`/movies?${params}`, 2, { signal });
        },

        async getMovieSynopsis(movieId, language) {
            if (!Number.isInteger(movieId) || movieId < 1) throw new Error('Invalid movie ID');
            const params = new URLSearchParams({ language });
            const data = await this.fetchJSON(`/movies/${movieId}/synopsis?${params}`, 0);
            if (data.movieId !== movieId || data.language !== language || typeof data.text !== 'string') {
                throw new Error('Synopsis unavailable');
            }
            return data.text.trim();
        },
    };

    // ============================================
    // TMDB Service — Poster Fetching
    // ============================================
    const TMDBService = {
        pendingPosters: new Map(),

        async getPosterURL(rawTitle, movieId) {
            const cacheKey = rawTitle.toLowerCase();
            const cache = STATE.tmdbCache;
            if (cache[cacheKey] !== undefined) {
                return cache[cacheKey]?.posterUrl || null;
            }
            const pending = this.pendingPosters.get(cacheKey);
            if (pending?.cache === cache) return pending.request;
            const entry = { cache, request: this.fetchPoster(movieId, cacheKey, cache) };
            this.pendingPosters.set(cacheKey, entry);
            try {
                return await entry.request;
            } finally {
                if (this.pendingPosters.get(cacheKey) === entry) this.pendingPosters.delete(cacheKey);
            }
        },

        async fetchPoster(movieId, cacheKey, cache) {
            try {
                const params = new URLSearchParams({ movie_id: movieId });
                const data = await API.fetchJSON(`/api/movie-posters?${params}`, 0);
                const posterUrl = data.poster_path ? `${CONFIG.TMDB_IMG_BASE}${data.poster_path}` : null;
                cache[cacheKey] = { posterUrl, rating: data.rating || 0 };
                return posterUrl;
            } catch {
                return null;
            }
        },
    };

    // Summary language and translations are shared by both card detail views.
    const SUMMARY_LANGUAGES = {
        tr: ['Türkçe', 'Özet hazırlanıyor…', 'Türkçe özet şu anda kullanılamıyor.', 'Bu film için özet bulunamadı.'],
        en: ['English', 'Loading synopsis…', 'The English synopsis is currently unavailable.', 'No synopsis is available for this film.'],
        es: ['Español', 'Cargando sinopsis…', 'La sinopsis en español no está disponible.', 'No hay sinopsis para esta película.'],
        fr: ['Français', 'Chargement du résumé…', 'Le résumé en français est indisponible.', 'Aucun résumé pour ce film.'],
        de: ['Deutsch', 'Inhalt wird geladen…', 'Die deutsche Inhaltsangabe ist derzeit nicht verfügbar.', 'Für diesen Film gibt es keine Inhaltsangabe.'],
        pt: ['Português', 'Carregando sinopse…', 'A sinopse em português está indisponível.', 'Este filme não tem sinopse.'],
        ru: ['Русский', 'Загрузка описания…', 'Описание на русском пока недоступно.', 'У этого фильма нет описания.'],
        ar: ['العربية', 'جارٍ تحميل الملخص…', 'الملخص بالعربية غير متاح الآن.', 'لا يوجد ملخص لهذا الفيلم.'],
        'zh-CN': ['简体中文', '正在加载简介…', '暂时没有可用的简体中文简介。', '此电影暂无简介。'],
        hi: ['हिन्दी', 'सारांश लोड हो रहा है…', 'हिन्दी सारांश अभी उपलब्ध नहीं है।', 'इस फ़िल्म का सारांश उपलब्ध नहीं है।'],
    };

    const SummaryLanguage = {
        current: 'tr',

        init() {
            try {
                const saved = localStorage.getItem('cineflow-summary-language');
                if (Object.prototype.hasOwnProperty.call(SUMMARY_LANGUAGES, saved)) this.current = saved;
            } catch { /* Storage may be disabled. */ }

            const picker = document.getElementById('summary-language');
            const choices = document.getElementById('summary-language-options');
            const display = document.getElementById('summary-language-code');
            const update = () => {
                display.textContent = this.current.split('-')[0].toUpperCase();
                picker.querySelector('summary').setAttribute('aria-label', `Özet dili: ${SUMMARY_LANGUAGES[this.current][0]}`);
                choices.querySelectorAll('button').forEach(button => {
                    button.setAttribute('aria-pressed', String(button.lang === this.current));
                });
            };

            for (const [language, [name]] of Object.entries(SUMMARY_LANGUAGES)) {
                const button = document.createElement('button');
                button.type = 'button';
                button.lang = language;
                button.dir = 'auto';
                button.textContent = name;
                button.setAttribute('aria-label', name);
                button.addEventListener('click', () => {
                    const changed = this.current !== language;
                    this.current = language;
                    try { localStorage.setItem('cineflow-summary-language', language); } catch { /* Optional storage. */ }
                    update();
                    picker.open = false;
                    picker.querySelector('summary').focus();
                    if (changed) SynopsisService.refreshOpen();
                });
                choices.append(button);
            }
            update();
            document.addEventListener('click', event => {
                if (picker.open && !picker.contains(event.target)) picker.open = false;
            });
            picker.addEventListener('keydown', event => {
                if (event.key === 'Escape' && picker.open) {
                    picker.open = false;
                    picker.querySelector('summary').focus();
                }
            });
        },
    };

    const SynopsisService = {
        translated: new Map(),
        views: new WeakMap(),

        get(movieId, language) {
            const key = `${movieId}:${language}`;
            if (!this.translated.has(key)) {
                const request = API.getMovieSynopsis(movieId, language).catch(error => {
                    if (this.translated.get(key) === request) this.translated.delete(key);
                    throw error;
                });
                this.translated.set(key, request);
                if (this.translated.size > 250) this.translated.delete(this.translated.keys().next().value);
            }
            return this.translated.get(key);
        },

        async render(element, movie) {
            const language = SummaryLanguage.current;
            const [, loading, unavailable, noSynopsis] = SUMMARY_LANGUAGES[language];
            const request = { movie, language, pending: true };
            const previous = this.views.get(element);
            if (previous?.movie === movie && previous.language === language && (previous.pending || previous.text)) return;
            this.views.set(element, request);
            element.lang = language;
            element.textContent = loading;
            try {
                request.text = await this.get(movie.movieId, language) || noSynopsis;
                if (this.views.get(element) === request) element.textContent = request.text;
            } catch {
                if (this.views.get(element) === request) element.textContent = unavailable;
            } finally {
                request.pending = false;
            }
        },

        refreshOpen() {
            const open = document.querySelectorAll(
                '#cold-start-view.view--active .swipe-card--front .swipe-card__synopsis, ' +
                '#hologram-modal:not(.hidden) .hologram-modal__synopsis'
            );
            open.forEach(element => {
                const view = this.views.get(element);
                if (view) this.render(element, view.movie);
            });
        },
    };

    function formatRating(rating) {
        return Number.isFinite(rating) && rating > 0 ? `${rating.toFixed(1)} / 10` : '—';
    }

    // ============================================
    // View Manager
    // ============================================
    const ViewManager = {
        switchTo(viewId) {
            if (viewId !== 'catalog-view') CatalogController.suspend();
            window.scrollTo(0, 0); // Always start from the top of the page on view switch
            document.querySelectorAll('.view').forEach(v => v.classList.remove('view--active'));
            const target = document.getElementById(viewId);
            if (target) {
                target.classList.add('view--active');
            }
            
            // Navigation is shared by recommendations and the local catalogue.
            const nav = document.getElementById('main-nav');
            if (nav) {
                if (viewId === 'home-view' || viewId === 'catalog-view') {
                    nav.style.display = ''; // CSS'teki orijinal display ayarına dön
                } else {
                    nav.style.display = 'none';
                }
            }
            document.querySelectorAll('.nav__link[data-view]').forEach(link => {
                const active = link.dataset.view === viewId;
                link.classList.toggle('active', active);
                if (active) link.setAttribute('aria-current', 'page');
                else link.removeAttribute('aria-current');
            });
        },

        showOnboarding() { this.switchTo('onboarding-view'); },
        showColdStart() { this.switchTo('cold-start-view'); },
        showTransition() {
            this.setTransitionStage('matching', 'Seçimlerine uygun filmler bulunuyor.');
            this.switchTo('transition-view');
        },
        setTransitionStage(stage, status) {
            DOM.transitionView.dataset.stage = stage;
            if (DOM.transitionStatus) DOM.transitionStatus.textContent = status;
        },
        showHome() { 
            this.switchTo('home-view'); 
            
            // Show Navbar gracefully with GSAP when entering home
            const nav = document.getElementById('main-nav');
            if (nav) {
                if (typeof gsap !== 'undefined') {
                    gsap.to(nav, {
                        y: 0,
                        opacity: 1,
                        duration: 1.2,
                        ease: 'power3.out',
                        delay: 0.3 // Kartlar belirmeden hemen önce usulca süzülür
                    });
                } else {
                    nav.style.transform = 'translateY(0)';
                    nav.style.opacity = '1';
                    nav.style.transition = 'all 1s ease';
                }
            }
        },
    };

    // ============================================
    // Onboarding — Year Selection
    // ============================================
    const OnboardingController = {
        init() {
            // Animasyon kalıntılarını temizle (Restart durumu için)
            if (typeof gsap !== 'undefined') {
                gsap.set('.onboarding__title, .onboarding__subtitle, .year-card', { clearProps: 'all' });
            }
            STATE.isOnboardingTransitioning = false;
            STATE.selectedGenres = [];
            document.getElementById('onboarding-view').classList.remove('is-animating');
            this.initGenres();

            ViewManager.showOnboarding();
            
            const buttons = document.querySelectorAll('#onboarding-view .year-card');
            buttons.forEach(btn => {
                // Remove old event listeners by replacing clone
                const newBtn = btn.cloneNode(true);
                // FIX: cloneNode(true) CSS class'larını da kopyalar.
                // Önceki oturumda seçilen butona eklenen 'hide-bg' class'ı
                // klona taşınarak border ve arka planın kaybolmasına neden olur.
                newBtn.classList.remove('hide-bg');
                btn.parentNode.replaceChild(newBtn, btn);
                
                newBtn.addEventListener('click', async () => {
                    if (STATE.isOnboardingTransitioning) return;
                    STATE.isOnboardingTransitioning = true;
                    document.getElementById('onboarding-view').classList.add('is-animating');

                    const min = newBtn.dataset.min;
                    const max = newBtn.dataset.max;
                    
                    STATE.selectedMinYear = min ? parseInt(min, 10) : null;
                    STATE.selectedMaxYear = max ? parseInt(max, 10) : null;
                    
                    // Butona tıklandığını hissettiren ufak sekme (tıklama) efekti
                    if (typeof gsap !== 'undefined') {
                        gsap.to(newBtn, { scale: 0.95, duration: 0.1, yoyo: true, repeat: 1 });
                    }

                    // 3D Çıkış Animasyonu
                    let animPromise;
                    if (typeof gsap !== 'undefined') {
                        animPromise = new Promise(resolve => {
                            // Tüm animasyon dizisini (timeline) başlatmadan önce gecikme (delay) ekliyoruz
                            const tl = gsap.timeline({ 
                                delay: 0.4, // Tüm süreci 0.4 saniye bekletip öyle başlatır
                                onComplete: resolve 
                            });
                            
                            const title = document.querySelector('.onboarding__title');
                            const subtitle = document.querySelector('.onboarding__subtitle');
                            const allBtns = Array.from(document.querySelectorAll('#onboarding-view .year-card'));
                            const otherBtns = allBtns.filter(b => b !== newBtn);
                            
                            tl.to([title, subtitle, ...otherBtns], {
                                y: -50,
                                opacity: 0,
                                duration: 0.3,
                                stagger: 0.1,
                                ease: 'power2.in'
                            });

                            const rect = newBtn.getBoundingClientRect();
                            const centerX = window.innerWidth / 2;
                            const centerY = window.innerHeight / 2;
                            const moveX = centerX - (rect.left + rect.width / 2);
                            const moveY = centerY - (rect.top + rect.height / 2);

                            tl.to(newBtn, {
                                x: moveX,
                                y: moveY,
                                scale: 1.2,
                                zIndex: 100,
                                boxShadow: '0 0 40px rgba(124, 111, 247, 0.8)',
                                duration: 0.5,
                                ease: 'power2.out'
                            });

                            tl.add(() => {
                                // Çerçeve için bağımsız bir "Portal" elementi oluştur
                                const portal = document.createElement('div');
                                const rect = newBtn.getBoundingClientRect();
                                const computed = window.getComputedStyle(newBtn);

                                portal.id = 'temp-portal';
                                portal.style.position = 'fixed';
                                portal.style.left = rect.left + 'px';
                                portal.style.top = rect.top + 'px';
                                portal.style.width = rect.width + 'px';
                                portal.style.height = rect.height + 'px';
                                portal.style.background = computed.background;
                                portal.style.backgroundColor = computed.backgroundColor;
                                portal.style.backgroundImage = computed.backgroundImage;
                                portal.style.backdropFilter = computed.backdropFilter;
                                portal.style.webkitBackdropFilter = computed.webkitBackdropFilter;
                                portal.style.border = computed.border;
                                portal.style.borderRadius = computed.borderRadius;
                                portal.style.boxShadow = computed.boxShadow;
                                portal.style.zIndex = '99'; // Butonun arkasında
                                portal.style.pointerEvents = 'none'; // Tıklamaları engellememesi için garanti
                                document.body.appendChild(portal);

                                // Orijinal butonun arka planını şeffaf yap (Sadece yazılar kalsın, hiçbir sıçrama olmaz)
                                newBtn.classList.add('hide-bg');

                                // Portal (çerçeve) yavaş yavaş hızlanarak genişlesin (power2.in mükemmel huni verir)
                                gsap.to(portal, {
                                    scale: 25,
                                    opacity: 0,
                                    duration: 1.5,
                                    ease: 'power2.in'
                                });

                                // Orijinal butonun içindeki metinler (butonun kendisi) zıplasın
                                gsap.to(newBtn, {
                                    scale: 1.8,
                                    duration: 0.5,
                                    ease: 'bounce.out',
                                    delay: 0.49
                                });

                                // Sağa sola sallan ve merkeze dön
                                gsap.to(newBtn, {
                                    keyframes: [
                                        { rotation: 8, duration: 0.15, ease: 'sine.out' },   
                                        { rotation: -8, duration: 0.2, ease: 'sine.inOut' }, 
                                        { rotation: 0, duration: 0.15, ease: 'sine.inOut' }  
                                    ],
                                    delay: 0.49
                                });
                                
                                // Orijinal butonu sahneden çıkışa doğru erit
                                gsap.to(newBtn, {
                                    opacity: 0,
                                    duration: 0.4,
                                    delay: 1.2 
                                });
                            });

                            // Metin animasyonlarının ve portalın bitmesini beklemesi için timeline'ı uzat
                            tl.to({}, { duration: 0.1 }, "+=1.5");
                        });
                    } else {
                        animPromise = Promise.resolve();
                    }
                    
                    await animPromise;
                    
                    // Geçici portal elementini DOM'dan temizle (tıklamaları engellememesi için)
                    const tempPortal = document.getElementById('temp-portal');
                    if (tempPortal) tempPortal.remove();

                    ViewManager.switchTo('genre-view');
                    document.getElementById('genre-title').focus();
                });
            });
        },

        initGenres() {
            const form = document.getElementById('genre-form');
            if (!form) return;
            const choices = document.getElementById('genre-choices');
            const status = document.getElementById('genre-status');
            const submit = document.getElementById('btn-start-cards');
            const back = document.getElementById('btn-back-to-years');
            if (!choices.children.length) {
                CATALOG_FILTER_OPTIONS.genre.filter(([value]) => value).forEach(([value, name]) => {
                    const label = document.createElement('label');
                    const input = document.createElement('input');
                    input.type = 'checkbox';
                    input.name = 'genres';
                    input.value = value;
                    input.className = 'sr-only';
                    const card = document.createElement('span');
                    card.className = 'year-card genre-card';
                    const title = document.createElement('span');
                    title.className = 'year-card__title';
                    title.textContent = name;
                    card.append(title);
                    label.append(input, card);
                    choices.append(label);
                });
            }
            form.reset();
            status.textContent = '';
            back.onclick = () => this.init();
            form.onsubmit = async event => {
                event.preventDefault();
                if (submit.disabled) return;
                STATE.selectedGenres = new FormData(form).getAll('genres');
                submit.disabled = back.disabled = true;
                status.textContent = 'Kartlar hazırlanıyor…';
                try {
                    const count = await ColdStartFlow.preloadAndFetch();
                    if (count) {
                        ViewManager.showColdStart();
                        ColdStartFlow.initAfterPreload();
                    } else {
                        status.textContent = 'Bu yıl ve tür seçimine uygun film bulunamadı.';
                    }
                } catch (error) {
                    console.error('Could not load film cards', error);
                    status.textContent = 'Kartlar yüklenemedi. Tekrar deneyebilirsin.';
                } finally {
                    submit.disabled = back.disabled = false;
                }
            };
        }
    };

    // ============================================
    // Cold Start — Card Rendering
    // ============================================
    const ColdStartFlow = {
        async preloadAndFetch() {
            const data = await API.getColdStartMovies();
            STATE.coldStartMovies = data.movies || [];
            STATE.currentCardIndex = 0;
            STATE.likedMovies = [];
            STATE.passedMovies = [];
            STATE.decisions = [];

            await mapConcurrent(STATE.coldStartMovies, 5, async movie => {
                await TMDBService.getPosterURL(movie.title, movie.movieId);
                warmPoster(STATE.tmdbCache[movie.title.toLowerCase()]);
            });
            this.renderProgressDots();
            await this.renderCardStack();
            return STATE.coldStartMovies.length;
        },

        initAfterPreload() {
            // Hata mesajı varsa bağlamayı atla
            if (DOM.cardStack.children.length > 0 && !DOM.cardStack.querySelector('.cold-start-error')) {
                this.bindEvents();
                this.animateEntrance();
            }
        },

        renderProgressDots() {
            DOM.progressDots.innerHTML = '';
            for (let i = 0; i < STATE.coldStartMovies.length; i++) {
                const dot = document.createElement('div');
                dot.className = 'progress-dot' + (i === 0 ? ' progress-dot--active' : '');
                dot.dataset.index = i;
                DOM.progressDots.appendChild(dot);
            }
        },

        async renderCardStack() {
            DOM.cardStack.innerHTML = '';

            const total = STATE.coldStartMovies.length;
            const start = STATE.currentCardIndex;
            
            // Kullanıcının talebi: Animasyonda hepsinin gerçek yüzünü görmek istiyoruz.
            // Bu nedenle tüm desteyi (10 kartı) paralel yükleyerek maksimum optimizasyon sağlıyoruz.
            const promises = [];
            for (let offset = total - start - 1; offset >= 0; offset--) {
                const idx = start + offset;
                promises.push(
                    this.createCardElement(STATE.coldStartMovies[idx], offset).then(card => ({ offset, card }))
                );
            }
            
            const results = await Promise.all(promises);
            results.sort((a, b) => b.offset - a.offset); // Ters sırayla eklemek için
            
            const fragment = document.createDocumentFragment();
            for (const res of results) fragment.appendChild(res.card);
            DOM.cardStack.appendChild(fragment);
        },

        async createCardElement(movie, stackOffset) {
            const card = document.createElement('div');
            card.className = 'swipe-card';
            
            // FOUC (Flash of Unstyled Content) engellemek için kartları DOM'a eklendiklerinde %100 şeffaf yap.
            // Bu sayede ViewManager.showColdStart() çalıştırıldığı milisaniyede ekranda pat diye belirmezler.
            // Sadece GSAP animasyonu başladığında yumuşakça görünür olurlar.
            card.style.opacity = '0';

            if (stackOffset === 0) {
                card.classList.add('swipe-card--front');
            } else if (stackOffset === 1) {
                card.classList.add('swipe-card--behind-1');
            } else if (stackOffset === 2) {
                card.classList.add('swipe-card--behind-2');
            } else {
                card.classList.add('swipe-card--hidden-deck');
            }

            // Genres as pills
            const genres = (movie.genres || '').split('|').filter(Boolean);
            const genrePills = genres.slice(0, 3).map(g =>
                `<span class="genre-pill">${g.trim()}</span>`
            ).join('');

            const rating = STATE.tmdbCache[movie.title.toLowerCase()]?.rating;

            card.innerHTML = `
                <div class="swipe-card__inner">
                    <div class="swipe-card__face swipe-card__front-face">
                        <div class="swipe-glow swipe-glow--like"></div>
                        <div class="swipe-glow swipe-glow--pass"></div>
                        <div class="swipe-overlay swipe-overlay--like">BEĞENDİM ✅</div>
                        <div class="swipe-overlay swipe-overlay--pass">GEÇ ❌</div>
                        <div class="swipe-card__poster-placeholder">🎬</div>
                        <div class="swipe-card__info">
                            <h2 class="swipe-card__title">${this.escapeHTML(movie.title)}</h2>
                            <div class="swipe-card__genres">${genrePills}</div>
                        </div>
                    </div>
                    <div class="swipe-card__face swipe-card__back-face">
                        <h2 class="swipe-card__back-title">${this.escapeHTML(movie.title)}</h2>
                        <div class="swipe-card__genres">${genrePills}</div>
                        <div class="film-detail-score"><span aria-hidden="true">★</span> TMDB <span class="film-detail-rating">${formatRating(rating)}</span></div>
                        <div class="swipe-card__divider"></div>
                        <p class="swipe-card__synopsis" dir="auto" aria-live="polite"></p>
                    </div>
                </div>
            `;

            // İlk kartın resminin geç gelmesini (siyah ekran) engellemek için,
            // kartı DOM'a eklemeden önce posterin adresini alıp resmi baştan ekliyoruz.
            const posterURL = await TMDBService.getPosterURL(movie.title, movie.movieId);
            if (posterURL) {
                const placeholder = card.querySelector('.swipe-card__poster-placeholder');
                if (placeholder) {
                    const { img, ready } = takePoster(STATE.tmdbCache[movie.title.toLowerCase()], true);
                    img.className = 'swipe-card__poster';
                    img.alt = movie.title;
                    placeholder.replaceWith(img);
                    await ready;
                }
            }

            return card;
        },

        animateEntrance() {
            STATE.isAnimating = true; // Kilit Açık: Animasyon bitene kadar etkileşim yasak
            DOM.cardStack.classList.add('is-dealing');
            
            // Gerçek kartların tümü (10 adet) renderCardStack tarafından oluşturuldu
            const allCards = DOM.cardStack.querySelectorAll('.swipe-card');
            
            // Görünürlük ayarları: Hepsini başlangıçta görünür yapıyoruz (Yüzleri açılacak)
            allCards.forEach(card => {
                card.style.visibility = 'visible';
            });

            if (typeof gsap !== 'undefined') {
                const tl = gsap.timeline({
                    onComplete: () => {
                        // Animasyon bittiğinde sadece ilk 3 kartı görünür bırak, diğerlerini gizle
                        allCards.forEach(card => {
                            if (card.classList.contains('swipe-card--hidden-deck')) {
                                card.style.visibility = 'hidden';
                                card.style.opacity = '0';
                            }
                            // GSAP'in hafızasındaki transform kalıntılarını kökünden temizle (Bozulmayı önler)
                            gsap.set(card, { clearProps: "transform" });
                        });
                        
                        // İlk 3 karta ufak bir pop (oturma) efekti
                        const visibleCards = DOM.cardStack.querySelectorAll('.swipe-card:not(.swipe-card--hidden-deck)');
                        const visibleArray = Array.from(visibleCards).reverse();
                        gsap.fromTo(visibleArray, 
                            { scale: 0.95 },
                            { 
                                scale: 1, 
                                duration: 0.4,
                                stagger: 0.1, 
                                ease: 'back.out(1.5)', 
                                clearProps: "scale",
                                onComplete: () => {
                                    DOM.cardStack.classList.remove('is-dealing');
                                    STATE.isAnimating = false; // Animasyon tamamen bitti, kilidi kaldır
                                }
                            }
                        );
                    }
                });

                const cardsArray = Array.from(allCards); 
                const isMobile = window.innerWidth <= 768;
                
                if (isMobile) {
                    // MOBİL TASARIM: Yukarıdan Aşağıya Şelale Efekti (Drop-in & Pile up)
                    tl.fromTo(cardsArray, 
                        { x: 0, y: -400, opacity: 0, rotation: () => (Math.random() - 0.5) * 40, scale: 0.8 },
                        {
                            x: () => (Math.random() - 0.5) * 20, // Hafif rastgele yatay dağınıklık
                            y: () => (Math.random() - 0.5) * 20, // Hafif rastgele dikey dağınıklık
                            rotation: () => (Math.random() - 0.5) * 15,
                            opacity: 1,
                            scale: 0.9,
                            duration: 0.56,
                            stagger: 0.06,
                            ease: 'power2.out'
                        }
                    );

                    // Dağınık düşen kartları ortada topla
                    tl.to(cardsArray, {
                        x: 0,
                        y: 0,
                        rotation: 0,
                        scale: 1,
                        duration: 0.48,
                        stagger: 0.03,
                        ease: 'power2.inOut'
                    }, "+=0.32");

                } else {
                    // MASAÜSTÜ TASARIM: Sağa Sola Yelpaze (Fan-out)
                    // PERF FIX: Math.random() GSAP tween function'ları içinde her frame çağrılıyordu.
                    // Değerler önceden hesaplanıp GSAP'e sabit array olarak geçiliyor.
                    const total = cardsArray.length;
                    const precomputedX = cardsArray.map((_, i) => (i - (total - 1) / 2) * 80);
                    const precomputedY = cardsArray.map((_, i) => Math.abs(i - (total - 1) / 2) * 20 - 20);
                    const precomputedRot = cardsArray.map((_, i) => (i - (total - 1) / 2) * 10);

                    // 1) 10 Gerçek Kartı daha yavaş ve geniş bir yelpazeyle aç (Fan-out)
                    tl.fromTo(cardsArray, 
                        { x: 0, y: 300, opacity: 0, rotation: 0, scale: 0.4 },
                        {
                            x: (index) => precomputedX[index],
                            y: (index) => precomputedY[index],
                            rotation: (index) => precomputedRot[index],
                            opacity: 1,
                            scale: 0.7, // Yüzleri görüneceği için ekrana sığsınlar
                            duration: 0.8, // 20% faster fan-out
                            stagger: 0.08, // Daha sakin yayılma ritmi
                            ease: 'back.out(1.0)'
                        }
                    );

                    // 2) Ortada daha yavaş topla (Collapse)
                    tl.to(cardsArray, {
                        x: 0,
                        y: 0,
                        rotation: 0, // Kullanıcı talebi: Kartlar jilet gibi düz (flat) üst üste otursun
                        scale: 1,
                        duration: 0.64, // 20% faster collapse
                        stagger: 0.05, 
                        ease: 'power2.inOut'
                    }, "+=0.5"); // 20% faster pause
                }
            } else {
                allCards.forEach(card => {
                    card.style.opacity = '1';
                    if (card.classList.contains('swipe-card--hidden-deck')) {
                        card.style.visibility = 'hidden';
                        card.style.opacity = '0';
                    }
                });
                DOM.cardStack.classList.remove('is-dealing');
                STATE.isAnimating = false;
            }
        },

        bindEvents() {
            if (this._eventsBound) return;
            this._eventsBound = true;

            // MEMORY FIX: Listener'lar isimlendirildi ve bu._handlers'a kaydedildi.
            // Bu sayede restart sırasında document üzerindeki listener'lar temizlenebilir.
            // Önceki tasarımda: bind(this) anonim fonksiyon üretiyordu → removeEventListener imkânsız.
            this._handlers = {
                pointerDown: this.onPointerDown.bind(this),
                pointerMove: this.onPointerMove.bind(this),
                pointerUp:   this.onPointerUp.bind(this),
                pointerCancel: this.onPointerCancel.bind(this),
                pass: () => this.triggerSwipe('pass'),
                like: () => this.triggerSwipe('like'),
                keyDown: (e) => {
                    if (!DOM.coldStartView.classList.contains('view--active')) return;
                    if (e.target instanceof Element && e.target.closest('#summary-language')) return;
                    if (e.key === 'ArrowLeft')  this.triggerSwipe('pass');
                    if (e.key === 'ArrowRight') this.triggerSwipe('like');
                },
            };

            // Pointer events on card stack for swipe
            DOM.cardStack.addEventListener('pointerdown', this._handlers.pointerDown);
            document.addEventListener('pointermove', this._handlers.pointerMove, { passive: true });
            document.addEventListener('pointerup',   this._handlers.pointerUp);
            document.addEventListener('pointercancel', this._handlers.pointerCancel);
            window.addEventListener('blur', this._handlers.pointerCancel);

            // Action buttons
            DOM.btnPass.addEventListener('click', this._handlers.pass);
            DOM.btnLike.addEventListener('click', this._handlers.like);

            // Keyboard
            document.addEventListener('keydown', this._handlers.keyDown);
        },

        // MEMORY FIX: Restart sırasında document'a bağlı tüm listener'ları kaldır.
        // Önceki tasarımda _eventsBound=true olduğundan yeniden çalışmıyordu ama
        // document listener'ları birikiyordu. Artık temizlik yapıldıktan sonra
        // _eventsBound=false'a alınıyor ki yeni bağlama yapılabilsin.
        unbindEvents() {
            if (!this._handlers) return;
            DOM.cardStack.removeEventListener('pointerdown', this._handlers.pointerDown);
            DOM.btnPass.removeEventListener('click', this._handlers.pass);
            DOM.btnLike.removeEventListener('click', this._handlers.like);
            document.removeEventListener('pointermove', this._handlers.pointerMove);
            document.removeEventListener('pointerup',   this._handlers.pointerUp);
            document.removeEventListener('pointercancel', this._handlers.pointerCancel);
            window.removeEventListener('blur', this._handlers.pointerCancel);
            document.removeEventListener('keydown',     this._handlers.keyDown);
            this.cancelDragFrame();
            STATE.isDragging = false;
            document.body.style.overflow = '';
            this._handlers = null;
            this._eventsBound = false;
        },

        // --- Swipe Mechanics ---

        onPointerDown(e) {
            if (STATE.isAnimating || STATE.isDragging || e.isPrimary === false || e.button > 0) return;
            
            const frontCard = DOM.cardStack.querySelector('.swipe-card--front');
            if (!frontCard) return;

            const target = e.target;
            const backFace = target.closest('.swipe-card__back-face');
            if (backFace && e.offsetX > backFace.clientWidth) return;

            STATE.isDragging = true;
            STATE.startX = e.clientX;
            STATE.startY = e.clientY;
            STATE.currentX = 0;
            this._pointerId = e.pointerId;
            this._dragCard = frontCard;
            this._dragTargets = {
                like: frontCard.querySelector('.swipe-overlay--like'),
                pass: frontCard.querySelector('.swipe-overlay--pass'),
                likeGlow: frontCard.querySelector('.swipe-glow--like'),
                passGlow: frontCard.querySelector('.swipe-glow--pass'),
            };
            this._dragViewportWidth = window.innerWidth;
            if (typeof gsap !== 'undefined') gsap.killTweensOf(frontCard);
            // PERF FIX: offsetWidth burada bir kez okunuyor (layout'u bir kez tetikler).
            // onPointerMove'da her frame'de DOM okuma yapılması forced reflow'ın
            // ana nedeni ve 30→60 FPS düşüşünün birincil sebebiydi.
            STATE.cachedCardWidth = frontCard.offsetWidth;
            frontCard.style.transition = 'none';
            // MOBİL FIX: Sürükleme başladığında body scroll'unu kilitle.
            // iOS'ta touch kaydırması ile swipe çakışmasını önler.
            document.body.style.overflow = 'hidden';
            if (!backFace) e.preventDefault();
        },

        onPointerMove(e) {
            if (!STATE.isDragging || e.pointerId !== this._pointerId) return;

            const frontCard = this._dragCard;
            if (!frontCard) return;

            STATE.currentX = e.clientX - STATE.startX;
            
            if (!this._ticking) {
                this._ticking = true;
                this._dragFrame = requestAnimationFrame(() => {
                    if (!STATE.isDragging || !frontCard.isConnected) {
                        this._ticking = false;
                        return;
                    }
                    const rotation = (STATE.currentX / this._dragViewportWidth) * CONFIG.MAX_ROTATION * 2;
                    const clampedRotation = Math.max(-CONFIG.MAX_ROTATION, Math.min(CONFIG.MAX_ROTATION, rotation));

                    // Use translate3d to enforce hardware acceleration composite layer
                    frontCard.style.transform = `translate3d(${STATE.currentX}px, 0, 0) rotateZ(${clampedRotation}deg)`;

                    // Show overlays based on direction
                    const { like: likeOverlay, pass: passOverlay, likeGlow, passGlow } = this._dragTargets;
                    // PERF FIX: DOM'dan offsetWidth okumak yerine pointer-down'da önbelleğe alınan değer kullanılıyor.
                    // Bu değişiklik her pointer-move frame'indeki forced reflow'u ortadan kaldırır.
                    const cardWidth = STATE.cachedCardWidth || 300;
                    const progress = Math.abs(STATE.currentX) / (cardWidth * CONFIG.SWIPE_THRESHOLD);

                    if (STATE.currentX > 0) {
                        likeOverlay.style.opacity = Math.min(1, progress);
                        passOverlay.style.opacity = 0;
                        if (likeGlow) likeGlow.style.opacity = Math.min(1, progress);
                        if (passGlow) passGlow.style.opacity = 0;
                    } else if (STATE.currentX < 0) {
                        passOverlay.style.opacity = Math.min(1, progress);
                        likeOverlay.style.opacity = 0;
                        if (passGlow) passGlow.style.opacity = Math.min(1, progress);
                        if (likeGlow) likeGlow.style.opacity = 0;
                    }
                    
                    this._ticking = false;
                });
            }
        },

        onPointerUp(e) {
            if (!STATE.isDragging || e.pointerId !== this._pointerId) return;
            STATE.isDragging = false;
            this.cancelDragFrame();
            // MOBİL FIX: Sürükleme bitince body scroll kilidini kaldır.
            document.body.style.overflow = '';

            const frontCard = DOM.cardStack.querySelector('.swipe-card--front');
            if (!frontCard) return;

            if (Math.abs(STATE.currentX) < 10 && Math.abs(e.clientY - STATE.startY) < 10) {
                this.executeFlipAnimation(frontCard);
                return;
            }

            // PERF FIX: offsetWidth forced reflow giderildi.
            // cachedCardWidth pointer-down'da bir kez okunmuş değer.
            const cardWidth = STATE.cachedCardWidth || frontCard.offsetWidth;
            const threshold = cardWidth * CONFIG.SWIPE_THRESHOLD;

            if (Math.abs(STATE.currentX) >= threshold) {
                // Swipe registered
                const direction = STATE.currentX > 0 ? 'like' : 'pass';
                this.executeSwipe(frontCard, direction);
            } else {
                // Snap back
                this.snapBack(frontCard);
            }
        },

        cancelDragFrame() {
            if (this._dragFrame) cancelAnimationFrame(this._dragFrame);
            this._dragFrame = null;
            this._ticking = false;
        },

        onPointerCancel(e) {
            if (!STATE.isDragging || (e?.pointerId !== undefined && e.pointerId !== this._pointerId)) return;
            STATE.isDragging = false;
            this.cancelDragFrame();
            document.body.style.overflow = '';
            if (this._dragCard?.isConnected) this.snapBack(this._dragCard);
            STATE.currentX = 0;
        },

        executeFlipAnimation(card) {
            if (STATE.isAnimating) return;
            const inner = card.querySelector('.swipe-card__inner');
            if (!inner) return;

            STATE.isAnimating = true;
            const isCurrentlyFlipped = card.classList.contains('is-flipped');
            
            if (!isCurrentlyFlipped) {
                const synopsis = inner.querySelector('.swipe-card__synopsis');
                const movie = STATE.coldStartMovies[STATE.currentCardIndex];
                if (synopsis && movie) SynopsisService.render(synopsis, movie);
            }

            // MOBİL FIX: Düşük performanslı cihazlarda (iPhone 7, iOS ≤ 13)
            // preserve-3d yerine CSS opacity crossfade kullanılıyor.
            // CSS tarafında .low-end-device .swipe-card__face { transition: opacity } tanımlandı.
            if (DEVICE.isLowEnd) {
                card.classList.toggle('is-flipped');
                STATE.isAnimating = false;
                return;
            }

            if (typeof gsap !== 'undefined') {
                const tl = gsap.timeline({
                    onComplete: () => {
                        card.classList.toggle('is-flipped');
                        STATE.isAnimating = false;
                    }
                });

                const targetRotY = isCurrentlyFlipped ? 0 : 180;
                const midRotY = isCurrentlyFlipped ? 90 : 90;
                
                // Pokemon card style flip: Move to side, rotate, and move back
                tl.to(inner, {
                    x: 150, 
                    z: 100, 
                    rotationY: midRotY,
                    rotationZ: 5,
                    scale: 1.15,
                    duration: 0.3,
                    force3D: true, // Force GPU layer
                    ease: 'power2.in'
                })
                .to(inner, {
                    x: 0,
                    z: 0,
                    rotationY: targetRotY,
                    rotationZ: 0,
                    scale: 1,
                    duration: 0.4,
                    force3D: true, // Force GPU layer
                    ease: 'back.out(1.2)'
                });
            } else {
                card.classList.toggle('is-flipped');
                inner.style.transform = isCurrentlyFlipped ? 'rotateY(0deg)' : 'rotateY(180deg)';
                STATE.isAnimating = false;
            }
        },

        triggerSwipe(direction) {
            if (STATE.isAnimating) return; // Animasyon sürerken butona/klavyeye basılmasını engelle
            
            const frontCard = DOM.cardStack.querySelector('.swipe-card--front');
            if (!frontCard || STATE.isDragging) return;
            this.executeSwipe(frontCard, direction);
        },

        executeSwipe(card, direction) {
            STATE.isAnimating = true; // Kilit: Kart uçarken başka bir tuşa/butona basılmasını engelle
            
            const movie = STATE.coldStartMovies[STATE.currentCardIndex];
            if (!movie) {
                STATE.isAnimating = false;
                return;
            }

            // Record decision
            STATE.decisions.push(direction);
            if (direction === 'like') {
                STATE.likedMovies.push(movie);
            } else {
                STATE.passedMovies.push(movie);
            }

            // Animate card off-screen
            const flyX = direction === 'like' ? window.innerWidth : -window.innerWidth;
            const flyRotation = direction === 'like' ? 30 : -30;
            
            // Eğer kart mouse ile sürükleniyorsa bulunduğu konumdan fırlat (Snap-back sorununu çözer)
            const startX = STATE.currentX || 0;
            const startRot = Math.max(-CONFIG.MAX_ROTATION, Math.min(CONFIG.MAX_ROTATION, startX * 0.1));

            if (typeof gsap !== 'undefined') {
                gsap.fromTo(card, 
                    { x: startX, rotation: startRot },
                    {
                        x: flyX,
                        rotation: flyRotation,
                        opacity: 0,
                        duration: 0.45,
                        ease: 'power2.in',
                        onComplete: () => {
                            STATE.currentX = 0;
                            this.onSwipeComplete();
                        },
                    }
                );
            } else {
                card.style.transition = '0.45s ease-in';
                card.style.transform = `translateX(${flyX}px) rotate(${flyRotation}deg)`;
                card.style.opacity = '0';
                setTimeout(() => {
                    STATE.currentX = 0;
                    this.onSwipeComplete();
                }, 450);
            }

            // Update progress dot
            this.updateProgressDot(STATE.currentCardIndex, direction);
        },

        snapBack(card) {
            if (typeof gsap !== 'undefined') {
                // Dragging writes CSS directly; seed GSAP's transform cache once
                // at release so it returns smoothly from the actual drag position.
                const rotation = Math.max(-CONFIG.MAX_ROTATION, Math.min(CONFIG.MAX_ROTATION,
                    (STATE.currentX / (this._dragViewportWidth || window.innerWidth)) * CONFIG.MAX_ROTATION * 2));
                gsap.fromTo(card, { x: STATE.currentX, rotation }, {
                    x: 0,
                    rotation: 0,
                    duration: 0.4,
                    ease: 'back.out(1.5)',
                    overwrite: 'auto',
                    onComplete: () => { if (!STATE.isDragging) STATE.currentX = 0; },
                });
            } else {
                card.style.transition = 'transform 0.4s ease';
                card.style.transform = 'translateX(0) rotate(0)';
            }

            // Hide overlays
            const likeOverlay = card.querySelector('.swipe-overlay--like');
            const passOverlay = card.querySelector('.swipe-overlay--pass');
            const likeGlow = card.querySelector('.swipe-glow--like');
            const passGlow = card.querySelector('.swipe-glow--pass');
            if (likeOverlay) likeOverlay.style.opacity = 0;
            if (passOverlay) passOverlay.style.opacity = 0;
            if (likeGlow) likeGlow.style.opacity = 0;
            if (passGlow) passGlow.style.opacity = 0;

            // The tween owns transform until the return movement finishes.
        },

        async onSwipeComplete() {
            STATE.currentCardIndex++;

            if (STATE.currentCardIndex >= STATE.coldStartMovies.length) {
                // All cards swiped — transition to home
                this.transitionToHome();
                return;
            }

            // 1) En öndeki (kaydırılan) kartı DOM'dan temizle
            const oldFrontCard = DOM.cardStack.querySelector('.swipe-card--front');
            if (oldFrontCard) oldFrontCard.remove();

            // 2) Arkadaki kartları birer adım öne kaydır (Flicker / Titreme çözümünün kalbi)
            const behind1 = DOM.cardStack.querySelector('.swipe-card--behind-1');
            const behind2 = DOM.cardStack.querySelector('.swipe-card--behind-2');

            if (behind1) {
                behind1.classList.remove('swipe-card--behind-1');
                behind1.classList.add('swipe-card--front');
                
                // GSAP ile 3D Derinlik animasyonu
                if (typeof gsap !== 'undefined') {
                    gsap.fromTo(behind1, 
                        { scale: 0.95, y: 20 }, 
                        { scale: 1, y: 0, duration: 0.4, ease: 'back.out(1.2)' }
                    );
                }
            }

            if (behind2) {
                behind2.classList.remove('swipe-card--behind-2');
                behind2.classList.add('swipe-card--behind-1');
                
                if (typeof gsap !== 'undefined') {
                    gsap.fromTo(behind2, 
                        { scale: 0.9, y: 40 }, 
                        { scale: 0.95, y: 20, duration: 0.4, ease: 'back.out(1.2)' }
                    );
                }
            }

            // 3) En arkaya (3. sıraya) önceden paralel yüklenmiş desteden sıradaki kartı getir
            // Not: DOM'da en altta duran kart destenin sonudur.
            const hiddenCards = DOM.cardStack.querySelectorAll('.swipe-card--hidden-deck');
            if (hiddenCards.length > 0) {
                // En sonuncu gizli kart sıradaki karttır (Çünkü renderCardStack tersten ekliyor)
                const newCard = hiddenCards[hiddenCards.length - 1];
                newCard.classList.remove('swipe-card--hidden-deck');
                newCard.classList.add('swipe-card--behind-2');
                newCard.style.visibility = 'visible';
                newCard.style.opacity = '1';
                
                if (typeof gsap !== 'undefined') {
                    gsap.fromTo(newCard, 
                        { opacity: 0, y: 60, scale: 0.8 }, 
                        { opacity: 1, y: 40, scale: 0.9, duration: 0.4, ease: 'back.out(1.2)' }
                    );
                }
            }

            // Alttaki kartların 0.4 saniyelik öne gelme animasyonları bittiğinde sistemi yeniden tıklamalara aç
            setTimeout(() => {
                STATE.isAnimating = false;
            }, 400);
        },

        updateProgressDot(index, direction) {
            const dot = DOM.progressDots.children[index];
            if (!dot) return;

            dot.classList.remove('progress-dot--active');
            dot.classList.add(direction === 'like' ? 'progress-dot--done-like' : 'progress-dot--done-pass');

            // Activate next dot
            const nextDot = DOM.progressDots.children[index + 1];
            if (nextDot) {
                nextDot.classList.add('progress-dot--active');
            }
        },

        async transitionToHome(remix = false) {
            if (STATE.isRecommending) return;
            STATE.isRecommending = true;
            const status = document.getElementById('recommendation-status');
            status.hidden = true;
            status.textContent = '';
            ViewManager.showTransition();
            const minTransitionTime = new Promise(resolve => setTimeout(resolve, 1200));

            try {
                const previousIds = remix ? STATE.currentRecommendations.map(movie => movie.movieId) : [];
                const recommendations = await RecommendEngine.generate(previousIds);
                ViewManager.setTransitionStage('cards', 'Film kartları hazırlanıyor.');
                await HomeRenderer.render(recommendations);
                if (recommendations.length > 0 && recommendations.length < CONFIG.HOME_MOVIE_COUNT) {
                    status.textContent = `Seçtiğin aralıkta ${recommendations.length} yeni film bulundu.`;
                    status.hidden = false;
                }
                ViewManager.setTransitionStage('ready', 'Film listesi açılıyor.');
                await minTransitionTime;
            } catch (error) {
                console.error('Could not prepare recommendations', error);
                if (!remix) await HomeRenderer.render([]);
                status.textContent = 'Öneriler yüklenemedi. Yeni karışım ile tekrar deneyebilirsin.';
                status.hidden = false;
            } finally {
                STATE.isRecommending = false;
            }

            ViewManager.showHome();
            HomeRenderer.animateCards();
            if (typeof lucide !== 'undefined') lucide.createIcons();
        },

        escapeHTML(str) {
            // GC FIX: Önceki tasarım her çağrıda geçici bir <div> DOM node'u oluşturuyordu.
            // 30 kart × 2 çağrı = 60 throwaway nesne → GC baskısı.
            // Regex tabanlı çözüm sıfır DOM allocation ile aynı güvenliği sağlar.
            return str
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        },
    };

    // ============================================
    // Recommendation Engine
    // ============================================
    const RecommendEngine = {
        async generate(previousIds = []) {
            const variation = typeof window.crypto?.getRandomValues === 'function'
                ? window.crypto.getRandomValues(new Uint32Array(1))[0]
                : Math.floor(Math.random() * 2 ** 32);
            const response = await API.getSessionRecommendations(previousIds, variation);
            return response.movies;
        },
    };

    const RECOMMENDATION_LABELS = {
        plot: 'Benzer konu', cast: 'Aynı başrol', genre: 'Ortak tür', discovery: 'Keşif seçkisi',
    };

    // ============================================
    // Home Page Renderer
    // ============================================
    const HomeRenderer = {
        _cards: new Map(),
        _renderVersion: 0,

        cancelAnimations() {
            if (this._entranceFrame) cancelAnimationFrame(this._entranceFrame);
            this._entranceFrame = null;
            // A stagger owns a parent timeline. Killing only its card targets
            // leaves that parent's completion callback alive during the next sort.
            if (this._entranceTween) this._entranceTween.kill();
            this._entranceTween = null;
            (this._fallbackTimers || []).forEach(clearTimeout);
            this._fallbackTimers = [];
            if (typeof gsap !== 'undefined') {
                gsap.killTweensOf(DOM.movieGrid.querySelectorAll('.movie-card'));
            }
            DOM.movieGrid.classList.remove('is-animating');
        },

        dispose() {
            this._renderVersion++;
            this.cancelAnimations();
            this._cards.clear();
            DOM.movieGrid.replaceChildren();
        },

        async render(movies, reuse = false) {
            const version = ++this._renderVersion;
            this.cancelAnimations();
            STATE.currentRecommendations = movies;
            this.bindSortEvent();
            if (!reuse) {
                this._cards.clear();
                document.querySelectorAll('.ag-filter-btn').forEach(btn => {
                    btn.classList.toggle('active', btn.dataset.sort === 'similarity');
                });
            }

            if (movies.length === 0) {
                DOM.movieGrid.innerHTML = `
                    <div style="grid-column: 1 / -1; text-align: center; padding: 3rem; color: var(--ag-text-secondary);">
                        <p style="font-size: 1.2rem; margin-bottom: 0.5rem;">Henüz öneri bulunamadı</p>
                        <p>Yeniden keşfederek yıl veya tür seçimini değiştirebilirsin.</p>
                    </div>`;
                return;
            }

            const cards = [];
            const nextCards = new Map();
            const fragment = document.createDocumentFragment();
            movies.forEach((movie, index) => {
                const key = movie.title.toLowerCase();
                const card = this._cards.get(key) || this.createMovieCard(movie, index);
                card.dataset.index = index;
                card.style.opacity = '0';
                card.style.removeProperty('transform');
                nextCards.set(key, card);
                fragment.appendChild(card);
                cards.push({ card, title: movie.title, index });
            });
            this._cards = nextCards;
            DOM.movieGrid.replaceChildren(fragment);
            await this.loadPostersInBatches(cards, version);
            return version === this._renderVersion;
        },

        createMovieCard(movie, index, catalogue = false) {
            const card = document.createElement('div');
            card.className = 'movie-card';
            card.style.opacity = '0';
            card.style.cursor = 'pointer'; // Make it look clickable
            card.dataset.index = index;
            card.dataset.movieId = movie.movieId;
            card.tabIndex = 0;
            card.setAttribute('role', 'button');
            card.setAttribute('aria-label', `${movie.title} detayları`);

            const genres = (movie.genres || '').split('|').filter(Boolean);
            const genrePills = genres.slice(0, 2).map(g =>
                `<span class="genre-pill">${ColdStartFlow.escapeHTML(g.trim())}</span>`
            ).join('');

            const reasonLabel = RECOMMENDATION_LABELS[movie.reasons?.[0]?.kind] || 'Sana özel';

            card.innerHTML = `
                <div class="movie-card__poster-placeholder">🎬</div>
                <div class="movie-card__body">
                    <h3 class="movie-card__title">${ColdStartFlow.escapeHTML(movie.title)}</h3>
                    <div class="movie-card__genres">${genrePills}</div>
                    <div class="movie-card__meta-row">
                        ${catalogue ? `<span class="movie-card__year">${Number(movie.year) || '—'}</span>` : `<span class="movie-card__reason">${reasonLabel}</span>`}
                        <div class="movie-card__rating" title="TMDB Puanı">
                            <i data-lucide="star" width="14" height="14"></i>
                            <span class="rating-value">-.-</span>
                        </div>
                    </div>
                </div>
            `;

            card.onclick = () => this.showModal(movie, catalogue);
            card.onkeydown = event => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    card.click();
                }
            };

            return card;
        },

        showModal(movie, catalogue = false) {
            const modal = document.getElementById('hologram-modal');
            if (!modal) return;
            const modalVersion = this._modalVersion = (this._modalVersion || 0) + 1;
            
            const poster = modal.querySelector('.hologram-modal__poster');
            const title = modal.querySelector('.hologram-modal__title');
            const genresContainer = modal.querySelector('.hologram-modal__genres');
            const synopsis = modal.querySelector('.hologram-modal__synopsis');
            const closeBtn = modal.querySelector('.hologram-modal__close');
            const overlay = modal.querySelector('.hologram-modal__overlay');
            
            // Get cached data
            const cacheKey = movie.title.toLowerCase();
            const tmdbData = STATE.tmdbCache[cacheKey];
            
            // Populate Modal
            title.textContent = !catalogue && tmdbData?.title ? tmdbData.title : movie.title;
            const posterUrl = tmdbData?.posterUrl;
            if (posterUrl) poster.src = posterUrl;
            else poster.removeAttribute('src');
            poster.style.display = posterUrl ? 'block' : 'none';

            // Render Genres
            let genrePills = '';
            let movieGenres = movie.genres || movie.genre || [];
            if (typeof movieGenres === 'string') {
                movieGenres = movieGenres.split(/[|,]/).map(g => g.trim()).filter(Boolean);
            }
            if (Array.isArray(movieGenres) && movieGenres.length > 0) {
                genrePills = movieGenres.map(g => `<span class="genre-pill">${ColdStartFlow.escapeHTML(g)}</span>`).join('');
                genresContainer.innerHTML = genrePills;
                genresContainer.style.display = 'flex';
            } else {
                genresContainer.style.display = 'none';
            }
            
            const rating = modal.querySelector('.film-detail-rating');
            const useIndex = catalogue && CatalogController.ratingAvailable;
            rating.textContent = formatRating(useIndex ? movie.tmdb_rating : tmdbData?.rating);
            if (tmdbData === undefined) {
                TMDBService.getPosterURL(movie.title, movie.movieId).then(() => {
                    if (this._modalVersion !== modalVersion) return;
                    const metadata = STATE.tmdbCache[cacheKey];
                    if (!useIndex) rating.textContent = formatRating(metadata?.rating);
                    if (metadata?.posterUrl) {
                        poster.src = metadata.posterUrl;
                        poster.style.display = 'block';
                    }
                });
            }
            this.renderRecommendationReasons(catalogue ? [] : movie.reasons || []);
            SynopsisService.render(synopsis, movie);

            // Show Modal
            modal.classList.remove('hidden');
            
            // Bind Close Event
            const closeModal = () => {
                this._modalVersion++;
                modal.classList.add('hidden');
            };
            closeBtn.onclick = closeModal;
            overlay.onclick = closeModal;
        },

        renderRecommendationReasons(reasons) {
            const container = document.getElementById('hologram-recommendation-reasons');
            container.replaceChildren();
            container.hidden = !reasons.length;
            if (!reasons.length) return;

            const heading = document.createElement('strong');
            heading.textContent = 'Neden önerildi?';
            const list = document.createElement('ul');
            for (const reason of reasons) {
                const item = document.createElement('li');
                if (reason.kind === 'cast') {
                    item.textContent = `${reason.actor} · ${reason.source_title} ile ortak başrol kadrosu`;
                } else if (reason.kind === 'genre') {
                    const names = reason.genres.map(genre => CATALOG_FILTER_OPTIONS.genre.find(([key]) => key === genre)?.[1] || genre);
                    item.textContent = `${reason.source_title} ile ortak tür · ${names.join(', ')}`;
                } else if (reason.kind === 'plot') {
                    item.textContent = `${reason.source_title} ile benzer konu`;
                } else {
                    item.textContent = 'Seçtiğin aralıktan bir keşif önerisi.';
                }
                list.append(item);
            }
            container.append(heading, list);
        },

        bindSortEvent() {
            const container = document.querySelector('.home-controls');
            if (container && !container.dataset.bound) {
                container.dataset.bound = "true";
                
                const buttons = container.querySelectorAll('[data-sort]');
                buttons.forEach(btn => {
                    btn.addEventListener('click', async (e) => {
                        if (!STATE.currentRecommendations) return;
                        
                        // Zaten aktif olan butona tıklandıysa hiçbir şey yapma
                        if (e.currentTarget.classList.contains('active')) return;
                        
                        // Aktif buton stilini değiştir
                        buttons.forEach(b => b.classList.remove('active'));
                        e.currentTarget.classList.add('active');
                        
                        const sortBy = e.currentTarget.dataset.sort;
                        let sortedMovies = [...STATE.currentRecommendations];
                        
                        if (sortBy === 'rating') {
                            sortedMovies.sort((a, b) => {
                                const cacheA = STATE.tmdbCache[a.title.toLowerCase()]?.rating || 0;
                                const cacheB = STATE.tmdbCache[b.title.toLowerCase()]?.rating || 0;
                                return cacheB - cacheA;
                            });
                        } else {
                            sortedMovies.sort((a, b) => (a.recommendation_rank || Infinity) - (b.recommendation_rank || Infinity));
                        }
                        
                        // Ekranı temizle, kartları bas ve KAYBOLMAMALARI için animasyonu tekrar tetikle
                        if (await this.render(sortedMovies, true)) this.animateCards();
                    });
                });
            }
        },



        // Bound decode work; prioritize the first two desktop rows. Remaining
        // posters retain native lazy loading instead of warming the entire grid.
        async loadPostersInBatches(cards, version) {
            await mapConcurrent(cards, 6, async ({ card, title, index }) => {
                if (version !== this._renderVersion) return;
                await this.loadSinglePoster(card, title, index < 10, version);
            });
        },

        async loadSinglePoster(card, title, critical, version) {
            try {
                const existing = card.querySelector('.movie-card__poster');
                if (existing) {
                    if (critical) {
                        existing.loading = 'eager';
                        await preparePoster(existing);
                    }
                    return;
                }
                const posterURL = await TMDBService.getPosterURL(title, Number(card.dataset.movieId));
                if (version !== this._renderVersion || !card.isConnected) return;
                
                // Update Rating UI
                const cacheKey = title.toLowerCase();
                const tmdbData = STATE.tmdbCache[cacheKey];
                if (tmdbData && tmdbData.rating) {
                    const ratingSpan = card.querySelector('.rating-value');
                    if (ratingSpan) ratingSpan.textContent = tmdbData.rating.toFixed(1);
                }

                if (posterURL) {
                    const placeholder = card.querySelector('.movie-card__poster-placeholder');
                    if (placeholder) {
                        const { img, ready } = takePoster(tmdbData, critical);
                        img.className = 'movie-card__poster';
                        img.alt = title;
                        const restorePlaceholder = () => { if (img.isConnected) img.replaceWith(placeholder); };
                        img.addEventListener('error', restorePlaceholder, { once: true });
                        placeholder.replaceWith(img);
                        if (critical) await ready;
                        if (img.complete && !img.naturalWidth) restorePlaceholder();
                    }
                }
            } catch (e) {
                // Ignore load errors in production
            }
        },

        animateCards() {
            this.cancelAnimations();
            const cards = DOM.movieGrid.querySelectorAll('.movie-card');
            if (!cards.length) return;
            DOM.movieGrid.classList.add('is-animating');

            if (typeof gsap !== 'undefined') {
                gsap.set(cards, { y: 60, opacity: 0, rotateX: -10 });
                // Give the browser a frame to prepare the entrance layers.
                this._entranceFrame = requestAnimationFrame(() => {
                    this._entranceFrame = requestAnimationFrame(() => {
                        this._entranceFrame = null;
                        this._entranceTween = gsap.fromTo(cards,
                            { y: 60, opacity: 0, rotateX: -10 },
                            {
                                y: 0,
                                opacity: 1,
                                rotateX: 0,
                                stagger: 0.06,
                                duration: 0.5,
                                ease: 'back.out(1.2)',
                                clearProps: 'transform',
                                onComplete: () => DOM.movieGrid.classList.remove('is-animating'),
                            }
                        );
                    });
                });
            } else {
                cards.forEach((card, i) => {
                    this._fallbackTimers.push(setTimeout(() => {
                        card.style.opacity = '1';
                        card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                        card.style.transform = 'translateY(0)';
                    }, i * 60));
                });
                DOM.movieGrid.classList.remove('is-animating');
            }


        },
    };

    // ============================================
    // Local catalogue — only /movies supplies film records.
    // TMDB enriches existing cards; it never supplies the catalogue list.
    // ============================================
    const CATALOG_FILTER_OPTIONS = {
        sort: [
            ['archive', 'Arşiv sırası', 'list'],
            ['votes-desc', 'En çok oy', 'users'],
            ['rating-desc', 'En yüksek puan', 'star'],
            ['rating-asc', 'En düşük puan', 'star-half'],
            ['year-desc', 'En yeni filmler', 'calendar-arrow-down'],
            ['year-asc', 'En eski filmler', 'calendar-arrow-up'],
            ['title-asc', 'Film adı A–Z', 'arrow-down-a-z'],
            ['title-desc', 'Film adı Z–A', 'arrow-up-a-z'],
        ],
        genre: [
            ['', 'Tümü'], ['Action', 'Aksiyon'], ['Animation', 'Animasyon'],
            ['Documentary', 'Belgesel'], ['Sci-Fi', 'Bilim kurgu'], ['Children', 'Çocuk'],
            ['Drama', 'Dram'], ['Fantasy', 'Fantastik'], ['Thriller', 'Gerilim'],
            ['Mystery', 'Gizem'], ['Film-Noir', 'Kara film'], ['Comedy', 'Komedi'],
            ['Horror', 'Korku'], ['Adventure', 'Macera'], ['Musical', 'Müzikal'],
            ['Romance', 'Romantik'], ['War', 'Savaş'], ['Crime', 'Suç'], ['Western', 'Western'],
        ],
        min_rating: [['', 'Tümü'], ['5', '5+'], ['6', '6+'], ['7', '7+'], ['8', '8+'], ['9', '9+']],
    };

    const CatalogController = {
        page: 1,
        query: '',
        filters: {},
        ratingAvailable: false,
        totalPages: 0,
        _version: 0,
        _loaded: false,
        _needsReload: false,

        init() {
            document.querySelectorAll('#main-nav [data-view]').forEach(link => {
                link.addEventListener('click', event => {
                    event.preventDefault();
                    if (link.dataset.view === 'catalog-view') this.show();
                    else ViewManager.showHome();
                });
            });
            const form = document.getElementById('catalog-search-form');
            form.addEventListener('submit', event => {
                event.preventDefault();
                clearTimeout(this._searchTimer);
                this.load(1, DOM.catalogSearch.value.trim());
            });
            DOM.catalogSearch.addEventListener('input', () => {
                clearTimeout(this._searchTimer);
                this.cancelRequest();
                this._needsReload = true;
                document.getElementById('catalog-clear').hidden = !DOM.catalogSearch.value;
                this._searchTimer = setTimeout(() => this.load(1, DOM.catalogSearch.value.trim()), 300);
            });
            document.getElementById('catalog-clear').addEventListener('click', () => {
                DOM.catalogSearch.value = '';
                DOM.catalogSearch.focus();
                this.load(1, '');
            });
            document.getElementById('catalog-prev').addEventListener('click', () => this.goToPage(this.page - 1));
            document.getElementById('catalog-next').addEventListener('click', () => this.goToPage(this.page + 1));

            this.filterMenu = document.getElementById('catalog-filter-dialog');
            this.filterForm = document.getElementById('catalog-filter-form');
            this.filterButton = document.getElementById('catalog-filter-button');
            this.filterClose = document.getElementById('catalog-filter-close');
            this.filterBackdrop = document.getElementById('catalog-filter-backdrop');
            this.activeFilters = document.getElementById('catalog-active-filters');
            this.buildFilterControls();
            this.updateRatingAvailability(false);
            this.filterButton.addEventListener('click', () => this.openFilters());
            this.filterClose.addEventListener('click', () => this.closeFilters());
            this.filterBackdrop.addEventListener('click', () => this.closeFilters());
            this.filterMenu.addEventListener('click', event => {
                if (event.target === this.filterMenu) this.closeFilters();
            });
            this.filterMenu.addEventListener('cancel', event => {
                event.preventDefault();
                this.closeFilters();
            });
            this.filterForm.addEventListener('submit', event => {
                event.preventDefault();
                const filters = Object.fromEntries([...new FormData(this.filterForm)]
                    .filter(([name, value]) => value && !(name === 'sort' && value === 'archive')));
                this.applyFilters(filters);
            });
            document.getElementById('catalog-filter-reset').addEventListener('click', () => this.applyFilters({}));
            this.filterMenu.addEventListener('keydown', event => {
                if (typeof this.filterMenu.showModal === 'function') return;
                if (event.key === 'Escape') {
                    event.preventDefault();
                    this.closeFilters();
                } else if (event.key === 'Tab') {
                    const last = this.filterForm.querySelector('[type="submit"]');
                    if (event.shiftKey && document.activeElement === this.filterClose) {
                        event.preventDefault();
                        last.focus();
                    } else if (!event.shiftKey && document.activeElement === last) {
                        event.preventDefault();
                        this.filterClose.focus();
                    }
                }
            });
        },

        buildFilterControls() {
            for (const [name, options] of Object.entries(CATALOG_FILTER_OPTIONS)) {
                const group = this.filterForm.querySelector(`[data-filter-options="${name}"]`);
                for (const [value, label, icon] of options) {
                    const choice = document.createElement('label');
                    choice.className = 'catalog-filter-choice';
                    const input = document.createElement('input');
                    input.type = 'radio';
                    input.name = name;
                    input.value = value;
                    input.defaultChecked = value === options[0][0];
                    if (name === 'sort' && /^(rating|votes)-/.test(value)) input.dataset.requiresRatings = '';
                    const text = document.createElement('span');
                    text.className = 'catalog-filter-choice__text';
                    if (icon) {
                        const pictogram = document.createElement('i');
                        pictogram.dataset.lucide = icon;
                        pictogram.setAttribute('aria-hidden', 'true');
                        text.append(pictogram);
                    }
                    text.append(label);
                    choice.append(input, text);
                    group.append(choice);
                }
            }
        },

        openFilters() {
            this.filterForm.reset();
            for (const [name, value] of Object.entries(this.filters)) {
                this.filterForm.elements.namedItem(name).value = value;
            }
            if (typeof this.filterMenu.showModal === 'function') {
                this.filterMenu.showModal();
            } else {
                this.filterMenu.setAttribute('open', '');
                this.filterMenu.setAttribute('role', 'dialog');
                this.filterMenu.setAttribute('aria-modal', 'true');
                this.filterBackdrop.hidden = false;
                DOM.catalogView.inert = true;
            }
            this.filterButton.setAttribute('aria-expanded', 'true');
            document.documentElement.classList.add('catalog-filter-open');
            this.filterForm.querySelector('.catalog-filter-fields').scrollTop = 0;
            this.filterClose.focus();
        },

        closeFilters(restoreFocus = true) {
            if (!this.filterMenu?.hasAttribute('open')) return;
            if (typeof this.filterMenu.close === 'function') this.filterMenu.close();
            else {
                this.filterMenu.removeAttribute('open');
                this.filterBackdrop.hidden = true;
                DOM.catalogView.inert = false;
            }
            this.filterButton.setAttribute('aria-expanded', 'false');
            document.documentElement.classList.remove('catalog-filter-open');
            if (restoreFocus) this.filterButton.focus();
        },

        updateRatingAvailability(available) {
            this.ratingAvailable = available;
            this.filterForm.querySelectorAll('[data-requires-ratings]').forEach(control => {
                control.disabled = !available;
            });
            document.getElementById('catalog-rating-unavailable').hidden = available;
        },

        renderAppliedFilters() {
            const count = Object.keys(this.filters).length;
            const badge = document.getElementById('catalog-filter-count');
            badge.textContent = count;
            badge.hidden = count === 0;
            this.filterButton.setAttribute('aria-label', count ? `Filtrele, ${count} seçim etkin` : 'Filtrele');
            this.activeFilters.hidden = count === 0;
            this.activeFilters.replaceChildren();

            for (const [name, value] of Object.entries(this.filters)) {
                let label = CATALOG_FILTER_OPTIONS[name]?.find(option => option[0] === value)?.[1] || value;
                if (name === 'min_rating') label = `TMDB ${label}`;
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'catalog-filter-chip';
                chip.textContent = label;
                chip.setAttribute('aria-label', `${label} seçimini kaldır`);
                const remove = document.createElement('span');
                remove.textContent = '×';
                remove.setAttribute('aria-hidden', 'true');
                chip.append(remove);
                chip.addEventListener('click', () => {
                    const next = { ...this.filters };
                    delete next[name];
                    this.applyFilters(next);
                });
                this.activeFilters.append(chip);
            }

            if (count > 1) {
                const clear = document.createElement('button');
                clear.type = 'button';
                clear.className = 'catalog-filter-clear-all';
                clear.textContent = 'Tümünü temizle';
                clear.addEventListener('click', () => this.applyFilters({}));
                this.activeFilters.append(clear);
            }
        },

        applyFilters(filters) {
            this.filters = filters;
            this.renderAppliedFilters();
            this.closeFilters(false);
            this.filterButton.focus();
            this.load(1, DOM.catalogSearch.value.trim());
        },

        show() {
            ViewManager.switchTo('catalog-view');
            const query = DOM.catalogSearch.value.trim();
            if (!this._loaded || this._needsReload || query !== this.query) {
                this.load(query === this.query ? this.page : 1, query);
            }
        },

        cancelRequest() {
            this._version++;
            this._controller?.abort();
            this._controller = null;
        },

        stopAnimation() {
            if (this._animationFrame) cancelAnimationFrame(this._animationFrame);
            this._animationFrame = null;
            this._tween?.kill();
            this._tween = null;
            if (!DOM.catalogGrid) return;
            DOM.catalogGrid.classList.remove('is-animating');
            const cards = DOM.catalogGrid.querySelectorAll('.movie-card');
            if (typeof gsap !== 'undefined' && cards.length) {
                gsap.set(cards, { opacity: 1, clearProps: 'transform' });
            }
        },

        suspend() {
            clearTimeout(this._searchTimer);
            this.closeFilters(false);
            if (this._loading || this._enriching) this._needsReload = true;
            this.cancelRequest();
            this._loading = false;
            this._enriching = false;
            this.stopAnimation();
        },

        reset() {
            this.suspend();
            this.page = 1;
            this.query = '';
            this.filters = {};
            this.filterForm.reset();
            this.renderAppliedFilters();
            this._loaded = false;
            this._needsReload = false;
            DOM.catalogSearch.value = '';
            DOM.catalogGrid.replaceChildren();
        },

        goToPage(page) {
            if (this._loading || page < 1 || page > this.totalPages) return;
            const query = DOM.catalogSearch.value.trim();
            this.load(query === this.query ? page : 1, query);
            window.scrollTo(0, 0);
        },

        async load(page, query) {
            clearTimeout(this._searchTimer);
            this.cancelRequest();
            this.stopAnimation();
            const version = this._version;
            const controller = this._controller = new AbortController();
            this.page = page;
            this.query = query;
            this._loading = true;
            this._needsReload = false;
            DOM.catalogGrid.setAttribute('aria-busy', 'true');
            DOM.catalogStatus.textContent = query ? 'Arşivde aranıyor…' : 'Film arşivi yükleniyor…';
            document.getElementById('catalog-clear').hidden = !DOM.catalogSearch.value;
            document.getElementById('catalog-pagination').hidden = true;
            this.showMessage('Filmler hazırlanıyor', 'Sinema arşivinden senin için getiriyoruz.');
            try {
                const data = await API.getCatalog(page, query, this.filters, controller.signal);
                if (version !== this._version) return;
                this.page = data.page;
                this.totalPages = data.total_pages;
                this._loaded = true;
                this.updateRatingAvailability(data.rating_available === true);
                const count = data.total_movies.toLocaleString('tr-TR');
                const filtered = query || this.filters.genre || this.filters.year || this.filters.min_rating;
                if (!data.movies.length) {
                    DOM.catalogStatus.textContent = '0 film';
                    this.showMessage(filtered ? 'Seçimlerine uygun film bulunamadı' : 'Arşivde henüz film yok',
                        filtered ? 'Aramayı veya filtreleri değiştirip tekrar deneyebilirsin.' : 'Filmler eklendiğinde burada görünecek.');
                    return;
                }
                const start = (this.page - 1) * 30 + 1;
                const end = start + data.movies.length - 1;
                DOM.catalogStatus.textContent = `${count} ${filtered ? 'sonuç' : 'film'} · ${start}–${end} gösteriliyor`;
                const fragment = document.createDocumentFragment();
                const cards = data.movies.map((movie, index) => {
                    const card = HomeRenderer.createMovieCard(movie, index, true);
                    const placeholder = card.querySelector('.movie-card__poster-placeholder');
                    placeholder.textContent = 'CineFlow';
                    const rating = card.querySelector('.rating-value');
                    rating.textContent = Number.isFinite(movie.tmdb_rating) ? movie.tmdb_rating.toFixed(1) : '—';
                    if (movie.tmdb_votes > 0) {
                        rating.parentElement.title = `TMDB puanı · ${movie.tmdb_votes.toLocaleString('tr-TR')} oy`;
                    }
                    fragment.appendChild(card);
                    return { card, movie };
                });
                DOM.catalogGrid.replaceChildren(fragment);
                this.renderPagination();
                if (typeof lucide !== 'undefined') lucide.createIcons();
                this.animateCards(cards.map(item => item.card));
                this.enrichCards(cards, version);
            } catch (error) {
                if (version !== this._version || error.name === 'AbortError') return;
                this._loaded = false;
                DOM.catalogStatus.textContent = 'Arşive şu anda ulaşılamıyor.';
                this.showMessage('Filmler yüklenemedi', 'Bağlantını kontrol edip tekrar deneyebilirsin.', true);
            } finally {
                if (version === this._version) {
                    this._loading = false;
                    DOM.catalogGrid.setAttribute('aria-busy', 'false');
                }
            }
        },

        showMessage(title, description, retry = false) {
            const box = document.createElement('div');
            box.className = 'catalog-empty';
            const heading = document.createElement('h2');
            heading.className = 'catalog-empty__title';
            heading.textContent = title;
            const text = document.createElement('p');
            text.textContent = description;
            box.append(heading, text);
            if (retry) {
                const button = document.createElement('button');
                button.className = 'catalog-retry';
                button.textContent = 'Tekrar dene';
                button.onclick = () => this.load(this.page, this.query);
                box.append(button);
            }
            DOM.catalogGrid.replaceChildren(box);
        },

        renderPagination() {
            const pagination = document.getElementById('catalog-pagination');
            pagination.hidden = this.totalPages < 2;
            document.getElementById('catalog-prev').disabled = this.page <= 1;
            document.getElementById('catalog-next').disabled = this.page >= this.totalPages;
            const pages = document.getElementById('catalog-pages');
            pages.replaceChildren();
            const windowStart = Math.max(1, Math.min(this.page - 2, this.totalPages - 4));
            const windowPages = Array.from({ length: Math.min(5, this.totalPages) }, (_, i) => windowStart + i);
            const visible = [...new Set([1, ...windowPages, this.totalPages])]
                .filter(page => page >= 1 && page <= this.totalPages).sort((a, b) => a - b);
            let previous = 0;
            for (const page of visible) {
                if (previous && page - previous > 1) {
                    const gap = document.createElement('span');
                    gap.className = 'catalog-page-gap';
                    gap.textContent = '…';
                    gap.setAttribute('aria-hidden', 'true');
                    pages.append(gap);
                }
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'catalog-page-btn';
                button.textContent = page;
                button.setAttribute('aria-label', `${page}. sayfa`);
                if (page === this.page) button.setAttribute('aria-current', 'page');
                button.onclick = () => { if (page !== this.page) this.goToPage(page); };
                pages.append(button);
                previous = page;
            }
        },

        animateCards(cards) {
            if (typeof gsap === 'undefined') {
                cards.forEach(card => { card.style.opacity = '1'; });
                return;
            }
            DOM.catalogGrid.classList.add('is-animating');
            gsap.set(cards, { y: 60, opacity: 0, rotateX: -10 });
            this._animationFrame = requestAnimationFrame(() => {
                this._animationFrame = null;
                this._tween = gsap.to(cards, {
                    y: 0, opacity: 1, rotateX: 0, stagger: 0.06,
                    duration: 0.5, ease: 'back.out(1.2)', clearProps: 'transform',
                    onComplete: () => DOM.catalogGrid.classList.remove('is-animating'),
                });
            });
        },

        async enrichCards(cards, version) {
            this._enriching = true;
            await mapConcurrent(cards, 4, async ({ card, movie }) => {
                if (version !== this._version) return;
                const posterURL = await TMDBService.getPosterURL(movie.title, movie.movieId);
                if (version !== this._version || !card.isConnected) return;
                const metadata = STATE.tmdbCache[movie.title.toLowerCase()];
                if (!this.ratingAvailable && metadata?.rating) {
                    card.querySelector('.rating-value').textContent = metadata.rating.toFixed(1);
                }
                const placeholder = card.querySelector('.movie-card__poster-placeholder');
                if (!posterURL) {
                    placeholder.textContent = 'Poster bulunamadı';
                    return;
                }
                const img = new Image();
                img.className = 'movie-card__poster';
                img.alt = movie.title;
                img.decoding = 'async';
                img.src = posterURL;
                await preparePoster(img);
                if (version !== this._version || !card.isConnected) return;
                if (img.complete && !img.naturalWidth) placeholder.textContent = 'Poster yüklenemedi';
                else placeholder.replaceWith(img);
            });
            if (version === this._version) this._enriching = false;
        },
    };

    // ============================================
    // Status Module
    // ============================================
    const StatusModule = {
        async check() {
            try {
                const data = await API.getHealthStatus();
                DOM.statusDot.classList.remove('status-dot--offline');
                DOM.statusText.textContent = 'Sistem Durumu: Çevrimiçi';
                DOM.statusMovies.textContent = `Film Sayısı: ${(data.total_movies || 0).toLocaleString('tr-TR')}`;
                DOM.statusUsers.parentElement.hidden = !data.total_users;
                DOM.statusUsers.textContent = `Demo kayıtları: ${(data.total_users || 0).toLocaleString('tr-TR')}`;
            } catch {
                DOM.statusDot.classList.add('status-dot--offline');
                DOM.statusText.textContent = 'Sistem Durumu: Çevrimdışı';
            }
        },
    };

    // ============================================
    // App Initialization
    // ============================================
    async function init() {
        cacheDOMRefs();
        CatalogController.init();
        SummaryLanguage.init();

        // Initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }

        // Start flow
        await OnboardingController.init();
        document.getElementById('btn-remix')?.addEventListener('click', () => ColdStartFlow.transitionToHome(true));

        // Check health status
        StatusModule.check();

        // Restart button
        if (DOM.btnRestart) {
            let isRestarting = false;
            DOM.btnRestart.addEventListener('click', async () => {
                if (isRestarting) return;
                isRestarting = true;
                
                // Butonu görsel olarak pasif yap
                DOM.btnRestart.style.opacity = '0.5';
                DOM.btnRestart.style.pointerEvents = 'none';
                
                // MEMORY FIX: Restart öncesi document listener'larını temizle.
                // unbindEvents() olmazsa her restart'ta yeni pointermove/pointerup/keydown
                // listener'ları birikerek bellek sızıntısına ve çoklu tetiklemeye neden olur.
                ColdStartFlow.unbindEvents();
                HomeRenderer.dispose();
                CatalogController.reset();

                STATE.tmdbCache = {};
                await OnboardingController.init();
                
                // Saniye sonra kilidi kaldır (onboarding ekranına geçildiğinde)
                setTimeout(() => {
                    isRestarting = false;
                    DOM.btnRestart.style.opacity = '1';
                    DOM.btnRestart.style.pointerEvents = 'auto';
                }, 1000);
            });
        }
    }

    // Wait for DOM + scripts
    if ('scrollRestoration' in history) {
        history.scrollRestoration = 'manual';
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.scrollTo(0, 0);
            // Small delay to ensure GSAP and Lucide are loaded
            setTimeout(init, 100);
        });
    } else {
        window.scrollTo(0, 0);
        setTimeout(init, 100);
    }
})();
