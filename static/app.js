/**
 * CineFlow — Antigravity Swipe & Recommendation Engine
 * =========================================================
 * Cold Start: Tinder-style swipe cards → Home: Personalized recommendations
 */

(function () {
    'use strict';

    // GSAP sekme değiştirildiğinde animasyonları dondurmasın, arka planda süre işlemeye devam etsin.
    // Kullanıcı başka sekmeye geçtiğinde animasyonlar duraklamaz, süre ilerler ve geri dönüldüğünde bitmiş/ilerlemiş olur.
    if (typeof gsap !== 'undefined') {
        gsap.ticker.lagSmoothing(0);
    }

    // ============================================
    // Configuration
    // ============================================
    const CONFIG = {
        TMDB_API_KEY: '', // API Anahtarı GitHub için gizlendi, Backend üzerinden güvenli (.env) şekilde çekiliyor
        TMDB_IMG_BASE: 'https://image.tmdb.org/t/p/w500',
        TMDB_SEARCH_URL: 'https://api.themoviedb.org/3/search/movie',
        SWIPE_THRESHOLD: 0.30, // 30% of card width
        MAX_ROTATION: 15, // degrees
        SIMILAR_LIMIT: 15, // per liked movie
        HOME_MOVIE_COUNT: 30,
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

        // Düşük bellek sınıfı: devicePixelRatio ≥ 2 + ekran genişliği < 430px
        // iPhone 7: 750×1334 px, ratio=2, RAM=2GB — bu threshold'u tam karşılar.
        const isSmallHighDPI = window.devicePixelRatio >= 2 && window.innerWidth < 430;

        // iOS 13 ve altı: backdrop-filter yavaş, preserve-3d bug'ları var
        const isLowEndIOS = isIOS && iosVersion <= 13;

        // Genel düşük performans sınıfı
        const isLowEnd = isLowEndIOS || (isMobile && isSmallHighDPI && navigator.hardwareConcurrency <= 4);

        // HTML köküne sınıf ekle → CSS tarafı bu sınıfa göre graceful degradation uygular
        if (isLowEnd)  document.documentElement.classList.add('low-end-device');
        if (isMobile)  document.documentElement.classList.add('is-mobile');
        if (isIOS)     document.documentElement.classList.add('is-ios');

        return { isMobile, isIOS, iosVersion, isLowEnd, isSmallHighDPI };
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

    function cacheDOMRefs() {
        DOM.coldStartView = document.getElementById('cold-start-view');
        DOM.transitionView = document.getElementById('transition-view');
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
    }


    // ============================================
    // API Layer
    // ============================================
    const API = {
        async fetchJSON(url, retries = 2) {
            const res = await fetch(url);
            // Handle TMDB rate limiting (429)
            if (res.status === 429 && retries > 0) {
                await new Promise(r => setTimeout(r, 1000));
                return this.fetchJSON(url, retries - 1);
            }
            if (!res.ok) throw new Error(`API Error: ${res.status}`);
            return res.json();
        },

        getColdStartMovies() {
            let url = `/cold-start?count=${CONFIG.COLD_START_COUNT}`;
            if (STATE.selectedMinYear) url += `&min_year=${STATE.selectedMinYear}`;
            if (STATE.selectedMaxYear) url += `&max_year=${STATE.selectedMaxYear}`;
            return this.fetchJSON(url);
        },

        getSimilarMovies(movieTitle, limit = CONFIG.SIMILAR_LIMIT) {
            let url = `/similar?movie_title=${encodeURIComponent(movieTitle)}&limit=${limit}`;
            if (STATE.selectedMinYear) url += `&min_year=${STATE.selectedMinYear}`;
            if (STATE.selectedMaxYear) url += `&max_year=${STATE.selectedMaxYear}`;
            return this.fetchJSON(url);
        },

        getHealthStatus() {
            return this.fetchJSON('/health');
        },

        async translateTextRaw(text) {
            try {
                const res = await fetch('/api/translate', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ q: text })
                });
                const data = await res.json();
                return data.translatedText || text;
            } catch (e) {
                return text;
            }
        },

        async translateText(text, targetElement) {
            targetElement.dataset.translated = 'true';
            targetElement.innerHTML = '<span style="opacity: 0.5; animation: pulseCore 1.5s infinite;">Çevriliyor...</span>';
            try {
                const translated = await this.translateTextRaw(text);
                targetElement.innerHTML = translated || text;
            } catch (e) {
                targetElement.innerHTML = text;
            }
        },
    };

    // ============================================
    // TMDB Service — Poster Fetching
    // ============================================
    const TMDBService = {
        /**
         * Extract clean movie name and year for TMDB search
         */
        cleanTitle(rawTitle) {
            // Extract year if present: "Movie Name (1995)" -> { name: "Movie Name", year: "1995" }
            const yearMatch = rawTitle.match(/\((\d{4})\)\s*$/);
            let name = rawTitle.replace(/\s*\(\d{4}\)\s*$/, '').trim();
            const year = yearMatch ? yearMatch[1] : null;

            // Handle "Title, The" -> "The Title" format
            const commaThe = name.match(/^(.+),\s*(The|A|An)\s*$/i);
            if (commaThe) {
                name = `${commaThe[2]} ${commaThe[1]}`;
            }

            return { name, year };
        },

        /**
         * Fetch poster URL from TMDB by movie title
         */
        async getPosterURL(rawTitle) {
            const { name: cleanName, year } = this.cleanTitle(rawTitle);
            const cacheKey = rawTitle.toLowerCase();

            // Check cache first
            if (STATE.tmdbCache[cacheKey] !== undefined) {
                return STATE.tmdbCache[cacheKey] ? STATE.tmdbCache[cacheKey].posterUrl : null;
            }

            try {
                // Try with year first for better accuracy
                let yearParam = year ? `&year=${year}` : '';
                let url = `${CONFIG.TMDB_SEARCH_URL}?api_key=${CONFIG.TMDB_API_KEY}&query=${encodeURIComponent(cleanName)}&language=tr-TR&page=1${yearParam}`;
                let data = await API.fetchJSON(url);

                // Fallback: if no results with year, try without year
                if ((!data.results || data.results.length === 0) && year) {
                    url = `${CONFIG.TMDB_SEARCH_URL}?api_key=${CONFIG.TMDB_API_KEY}&query=${encodeURIComponent(cleanName)}&language=tr-TR&page=1`;
                    data = await API.fetchJSON(url);
                }

                if (data.results && data.results.length > 0) {
                    // Find the first result that actually has a poster, fallback to first result
                    const validResult = data.results.find(r => r.poster_path) || data.results[0];
                    const fullURL = validResult.poster_path ? `${CONFIG.TMDB_IMG_BASE}${validResult.poster_path}` : null;
                    
                    STATE.tmdbCache[cacheKey] = {
                        id: validResult.id,
                        posterUrl: fullURL,
                        overview: validResult.overview || '',
                        title: validResult.title || cleanName,
                        rating: validResult.vote_average || 0
                    };
                    return fullURL;
                }
                
                STATE.tmdbCache[cacheKey] = null;
                return null;
            } catch (e) {
                STATE.tmdbCache[cacheKey] = null;
                return null;
            }
        },
    };

    // ============================================
    // View Manager
    // ============================================
    const ViewManager = {
        switchTo(viewId) {
            window.scrollTo(0, 0); // Always start from the top of the page on view switch
            document.querySelectorAll('.view').forEach(v => v.classList.remove('view--active'));
            const target = document.getElementById(viewId);
            if (target) {
                target.classList.add('view--active');
            }
            
            // Sadece öneriler sayfasında navbar'ı göster
            const nav = document.getElementById('main-nav');
            if (nav) {
                if (viewId === 'home-view') {
                    nav.style.display = ''; // CSS'teki orijinal display ayarına dön
                } else {
                    nav.style.display = 'none';
                }
            }
        },

        showOnboarding() { this.switchTo('onboarding-view'); },
        showColdStart() { this.switchTo('cold-start-view'); },
        showTransition() { this.switchTo('transition-view'); },
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

            ViewManager.showOnboarding();
            
            const buttons = document.querySelectorAll('.year-card');
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

                    const min = newBtn.dataset.min;
                    const max = newBtn.dataset.max;
                    
                    STATE.selectedMinYear = min ? parseInt(min, 10) : null;
                    STATE.selectedMaxYear = max ? parseInt(max, 10) : null;
                    
                    // Başlar başlamaz arka planda verileri ve resimleri çek (preload)
                    const preloadPromise = ColdStartFlow.preloadAndFetch();
                    
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
                            const allBtns = Array.from(document.querySelectorAll('.year-card'));
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
                        animPromise = new Promise(resolve => setTimeout(resolve, 2400));
                    }
                    
                    // Hem animasyon hem preload bittiğinde geçiş yap
                    await Promise.all([animPromise, preloadPromise]);
                    
                    // Geçici portal elementini DOM'dan temizle (tıklamaları engellememesi için)
                    const tempPortal = document.getElementById('temp-portal');
                    if (tempPortal) tempPortal.remove();

                    ViewManager.showColdStart();
                    ColdStartFlow.initAfterPreload();
                });
            });
        }
    };

    // ============================================
    // Movie Validator (Data Quality Check)
    // ============================================
    const MovieValidator = {
        isValid(movie, tmdbData) {
            const hasPoster = !!(tmdbData && tmdbData.posterUrl);
            const hasRating = !!(tmdbData && tmdbData.rating > 0);
            
            let hasGenre = false;
            if (movie.genres && typeof movie.genres === 'string') {
                const g = movie.genres.trim();
                hasGenre = g !== '' && g !== '(no genres listed)';
            }

            // Must have a poster AND at least one of (genre or rating)
            return hasPoster && (hasGenre || hasRating);
        }
    };

    // ============================================
    // Cold Start — Card Rendering
    // ============================================
    const ColdStartFlow = {
        async preloadAndFetch() {
            try {
                const data = await API.getColdStartMovies();
                STATE.coldStartMovies = data.movies || [];
                STATE.currentCardIndex = 0;
                STATE.likedMovies = [];
                STATE.passedMovies = [];
                STATE.decisions = [];

                // Arka planda posterleri preload yap ve çevirileri başlat
                const preloadPromises = STATE.coldStartMovies.map(async (movie) => {
                    const posterURL = await TMDBService.getPosterURL(movie.title);
                    
                    const cacheKey = movie.title.toLowerCase();
                    const tmdbData = STATE.tmdbCache[cacheKey];
                    const textToTranslate = (tmdbData && tmdbData.overview) ? tmdbData.overview : (movie.overview || '');
                    
                    if (textToTranslate && (!tmdbData || !tmdbData.translationPromise)) {
                        if (!STATE.tmdbCache[cacheKey]) STATE.tmdbCache[cacheKey] = {};
                        STATE.tmdbCache[cacheKey].translationPromise = API.translateTextRaw(textToTranslate).then(translated => {
                            STATE.tmdbCache[cacheKey].overview_tr = translated;
                            const activeCard = document.querySelector('.swipe-card--front.is-flipped');
                            if (activeCard) {
                                const titleEl = activeCard.querySelector('.swipe-card__title');
                                if (titleEl && titleEl.textContent === movie.title) {
                                    const synopsisEl = activeCard.querySelector('.swipe-card__synopsis');
                                    if (synopsisEl && synopsisEl.innerHTML.includes('Çevriliyor')) {
                                        synopsisEl.innerHTML = translated;
                                    }
                                }
                            }
                        });
                    }

                    if (posterURL) {
                        // Resmin indirilmesini arka planda başlat, ama UI'ı bekletme
                        const img = new Image();
                        img.src = posterURL;
                        return Promise.resolve();
                    }
                });
                await Promise.all(preloadPromises);

                // Veri kalitesi düşük filmleri filtrele
                STATE.coldStartMovies = STATE.coldStartMovies.filter(movie => {
                    const cacheKey = movie.title.toLowerCase();
                    const tmdbData = STATE.tmdbCache[cacheKey];
                    return MovieValidator.isValid(movie, tmdbData);
                });

                if (STATE.coldStartMovies.length === 0) {
                    // Eğer tüm filmler kalitesizse direkt ana ekrana geç (rastgele 10 tane daha çekmek yerine)
                    this.transitionToHome();
                    return;
                }

                // Geçici portal elementini DOM'dan temizle
                const tempPortal = document.getElementById('temp-portal');

                this.renderProgressDots();
                await this.renderCardStack();
            } catch (e) {
                console.error("Preload error", e);
                DOM.cardStack.innerHTML = `
                    <div class="cold-start-error" style="text-align:center; color: var(--ag-text-secondary); padding: 2rem;">
                        Bir hata oluştu, lütfen sayfayı yenileyin.
                    </div>`;
            }
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
            
            for (const res of results) {
                DOM.cardStack.appendChild(res.card);
            }
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

            // Overview
            const overview = movie.overview || '';

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
                        <div class="swipe-card__divider"></div>
                        <p class="swipe-card__synopsis">Yükleniyor...</p>
                    </div>
                </div>
            `;

            // İlk kartın resminin geç gelmesini (siyah ekran) engellemek için,
            // kartı DOM'a eklemeden önce posterin adresini alıp resmi baştan ekliyoruz.
            const posterURL = await TMDBService.getPosterURL(movie.title);
            if (posterURL) {
                const placeholder = card.querySelector('.swipe-card__poster-placeholder');
                if (placeholder) {
                    const img = document.createElement('img');
                    img.className = 'swipe-card__poster';
                    img.src = posterURL;
                    img.alt = movie.title;
                    img.loading = 'eager'; // Cold Start için hemen yükle
                    img.decoding = 'async'; // LCP optimizasyonu: Main thread'i bloklamasını önle
                    placeholder.replaceWith(img);
                }
            }

            return card;
        },

        animateEntrance() {
            STATE.isAnimating = true; // Kilit Açık: Animasyon bitene kadar etkileşim yasak
            
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
                    if (card.classList.contains('swipe-card--hidden-deck')) {
                        card.style.visibility = 'hidden';
                        card.style.opacity = '0';
                    }
                });
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
                pointerMove: this.onPointerMove.bind(this),
                pointerUp:   this.onPointerUp.bind(this),
                keyDown: (e) => {
                    if (!DOM.coldStartView.classList.contains('view--active')) return;
                    if (e.key === 'ArrowLeft')  this.triggerSwipe('pass');
                    if (e.key === 'ArrowRight') this.triggerSwipe('like');
                },
            };

            // Pointer events on card stack for swipe
            DOM.cardStack.addEventListener('pointerdown', this.onPointerDown.bind(this));
            document.addEventListener('pointermove', this._handlers.pointerMove, { passive: true });
            document.addEventListener('pointerup',   this._handlers.pointerUp);

            // Action buttons
            DOM.btnPass.addEventListener('click', () => this.triggerSwipe('pass'));
            DOM.btnLike.addEventListener('click', () => this.triggerSwipe('like'));

            // Keyboard
            document.addEventListener('keydown', this._handlers.keyDown);
        },

        // MEMORY FIX: Restart sırasında document'a bağlı tüm listener'ları kaldır.
        // Önceki tasarımda _eventsBound=true olduğundan yeniden çalışmıyordu ama
        // document listener'ları birikiyordu. Artık temizlik yapıldıktan sonra
        // _eventsBound=false'a alınıyor ki yeni bağlama yapılabilsin.
        unbindEvents() {
            if (!this._handlers) return;
            document.removeEventListener('pointermove', this._handlers.pointerMove);
            document.removeEventListener('pointerup',   this._handlers.pointerUp);
            document.removeEventListener('keydown',     this._handlers.keyDown);
            this._handlers = null;
            this._eventsBound = false;
        },

        // --- Swipe Mechanics ---

        onPointerDown(e) {
            if (STATE.isAnimating) return; // Animasyon sürerken dokunmayı engelle
            
            const frontCard = DOM.cardStack.querySelector('.swipe-card--front');
            if (!frontCard) return;

            const target = e.target;
            const backFace = target.closest('.swipe-card__back-face');
            if (backFace && e.offsetX > backFace.clientWidth) return;

            STATE.isDragging = true;
            STATE.startX = e.clientX;
            STATE.startY = e.clientY;
            STATE.currentX = 0;
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
            if (!STATE.isDragging) return;

            const frontCard = DOM.cardStack.querySelector('.swipe-card--front');
            if (!frontCard) return;

            STATE.currentX = e.clientX - STATE.startX;
            
            if (!this._ticking) {
                this._ticking = true;
                requestAnimationFrame(() => {
                    const rotation = (STATE.currentX / window.innerWidth) * CONFIG.MAX_ROTATION * 2;
                    const clampedRotation = Math.max(-CONFIG.MAX_ROTATION, Math.min(CONFIG.MAX_ROTATION, rotation));

                    // Use translate3d to enforce hardware acceleration composite layer
                    frontCard.style.transform = `translate3d(${STATE.currentX}px, 0, 0) rotateZ(${clampedRotation}deg)`;

                    // Show overlays based on direction
                    const likeOverlay = frontCard.querySelector('.swipe-overlay--like');
                    const passOverlay = frontCard.querySelector('.swipe-overlay--pass');
                    const likeGlow = frontCard.querySelector('.swipe-glow--like');
                    const passGlow = frontCard.querySelector('.swipe-glow--pass');
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
            if (!STATE.isDragging) return;
            STATE.isDragging = false;
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

        executeFlipAnimation(card) {
            if (STATE.isAnimating) return;
            const inner = card.querySelector('.swipe-card__inner');
            if (!inner) return;

            STATE.isAnimating = true;
            const isCurrentlyFlipped = card.classList.contains('is-flipped');
            
            // Translate the synopsis when flipping for the first time
            const synopsisEl = inner.querySelector('.swipe-card__synopsis');
            if (synopsisEl && !synopsisEl.dataset.translated) {
                const movie = STATE.coldStartMovies[STATE.currentCardIndex];
                const cacheKey = movie.title.toLowerCase();
                const tmdbData = STATE.tmdbCache[cacheKey] || {};
                
                if (tmdbData.overview_tr) {
                    synopsisEl.innerHTML = tmdbData.overview_tr;
                    synopsisEl.dataset.translated = 'true';
                } else if (tmdbData.translationPromise) {
                    synopsisEl.dataset.translated = 'true';
                    synopsisEl.innerHTML = '<span style="opacity: 0.5; animation: pulseCore 1.5s infinite;">Çevriliyor...</span>';
                } else {
                    const textToTranslate = (tmdbData && tmdbData.overview) ? tmdbData.overview : (movie.overview || 'Bu film için henüz Türkçe özet bulunmuyor.');
                    API.translateText(textToTranslate, synopsisEl);
                }
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
                gsap.to(card, {
                    x: 0,
                    rotation: 0,
                    duration: 0.4,
                    ease: 'back.out(1.5)',
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
            
            // PERF FIX: Boş string yerine translate3d(0,0,0) kullanılıyor.
            // Boş string GPU layer'dan promotion'u sürekli düşürür ve
            // bir sonraki swipe'da yeniden promotion maliyeti öder.
            // translate3d(0,0,0) layer'u canlı tutar.
            card.style.transform = 'translate3d(0,0,0) rotateZ(0deg)';
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

        async transitionToHome() {
            ViewManager.showTransition();
            const minTransitionTime = new Promise(r => setTimeout(r, 2500));

            // Generate recommendations based on liked movies
            const recommendations = await RecommendEngine.generate(STATE.likedMovies);
            STATE.currentRecommendations = recommendations;

            // Arka planda posterleri ve çevirileri başlat
            const BATCH_SIZE = 5;
            for (let i = 0; i < recommendations.length; i += BATCH_SIZE) {
                const batch = recommendations.slice(i, i + BATCH_SIZE);
                for (const movie of batch) {
                    const posterURL = await TMDBService.getPosterURL(movie.title);
                    
                    const cacheKey = movie.title.toLowerCase();
                    const tmdbData = STATE.tmdbCache[cacheKey];
                    const textToTranslate = (tmdbData && tmdbData.overview) ? tmdbData.overview : (movie.overview || '');
                    
                    if (textToTranslate && (!tmdbData || !tmdbData.translationPromise)) {
                        if (!STATE.tmdbCache[cacheKey]) STATE.tmdbCache[cacheKey] = {};
                        STATE.tmdbCache[cacheKey].translationPromise = API.translateTextRaw(textToTranslate).then(translated => {
                            STATE.tmdbCache[cacheKey].overview_tr = translated;
                            
                            const modal = document.getElementById('hologram-modal');
                            if (modal && !modal.classList.contains('hidden')) {
                                const titleEl = modal.querySelector('.hologram-modal__title');
                                if (titleEl && titleEl.textContent === movie.title) {
                                    const synopsisEl = modal.querySelector('.hologram-modal__synopsis');
                                    if (synopsisEl && synopsisEl.innerHTML.includes('Yapay Zeka çevirisi')) {
                                        synopsisEl.innerHTML = translated;
                                    }
                                }
                            }
                        });
                    }

                    if (posterURL) {
                        const img = new Image();
                        img.src = posterURL;
                    }
                }
                if (i + BATCH_SIZE < recommendations.length) {
                    await new Promise(r => setTimeout(r, 150));
                }
            }

            // Veri kalitesi düşük önerileri ve mükerrer (kopya) TMDB sonuçlarını filtrele
            const seenTmdbIds = new Set();
            
            const validRecommendations = recommendations.filter(movie => {
                const cacheKey = movie.title.toLowerCase();
                const tmdbData = STATE.tmdbCache[cacheKey];
                
                if (!MovieValidator.isValid(movie, tmdbData)) return false;
                
                // Aynı TMDB ID'ye (aynı filme) sahip birden fazla kayıt varsa, sadece ilkini tut.
                if (tmdbData && tmdbData.id) {
                    if (seenTmdbIds.has(tmdbData.id)) {
                        return false;
                    }
                    seenTmdbIds.add(tmdbData.id);
                }
                
                return true;
            });
            STATE.currentRecommendations = validRecommendations;

            // Wait for at least the minimum transition time
            await minTransitionTime;

            HomeRenderer.render(validRecommendations);
            ViewManager.showHome();
            HomeRenderer.animateCards();

            if (typeof lucide !== 'undefined') {
                lucide.createIcons();
            }
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
        async generate(likedMovies) {
            if (likedMovies.length === 0) {
                // If user liked nothing, just get random recommendations
                try {
                    const data = await API.getColdStartMovies();
                    return (data.movies || []).map(m => ({
                        ...m,
                        similarity_score: 0.5,
                    }));
                } catch {
                    return [];
                }
            }

            const allResults = [];
            const seenTitles = new Set();

            // Add liked movies to seen (don't recommend them again)
            likedMovies.forEach(m => seenTitles.add(m.title.toLowerCase()));
            STATE.passedMovies.forEach(m => seenTitles.add(m.title.toLowerCase()));

            // Fetch similar movies for each liked movie
            const promises = likedMovies.map(movie =>
                API.getSimilarMovies(movie.title, CONFIG.SIMILAR_LIMIT)
                    .catch(e => {
                        return null;
                    })
            );

            const results = await Promise.all(promises);

            results.forEach(data => {
                if (!data || !data.similar_movies) return;

                data.similar_movies.forEach(movie => {
                    const key = movie.title.toLowerCase();
                    if (!seenTitles.has(key)) {
                        seenTitles.add(key);
                        allResults.push(movie);
                    }
                });
            });

            // Sort by similarity score descending
            allResults.sort((a, b) => (b.similarity_score || 0) - (a.similarity_score || 0));

            // Return top N
            return allResults.slice(0, CONFIG.HOME_MOVIE_COUNT);
        },
    };

    // ============================================
    // Home Page Renderer
    // ============================================
    const HomeRenderer = {
        render(movies) {
            STATE.currentRecommendations = movies;
            this.bindSortEvent();
            DOM.movieGrid.innerHTML = '';

            if (movies.length === 0) {
                DOM.movieGrid.innerHTML = `
                    <div style="grid-column: 1 / -1; text-align: center; padding: 3rem; color: var(--ag-text-secondary);">
                        <p style="font-size: 1.2rem; margin-bottom: 0.5rem;">Henüz öneri bulunamadı</p>
                        <p>Daha fazla film beğenmeyi deneyin!</p>
                    </div>`;
                return;
            }

            // Create all cards first (without posters)
            const cards = [];
            movies.forEach((movie, index) => {
                const card = this.createMovieCard(movie, index);
                DOM.movieGrid.appendChild(card);
                cards.push({ card, title: movie.title });
            });

            // Then load posters in batches to avoid TMDB rate limiting
            this.loadPostersInBatches(cards);
        },

        createMovieCard(movie, index) {
            const card = document.createElement('div');
            card.className = 'movie-card';
            card.style.opacity = '0';
            card.style.cursor = 'pointer'; // Make it look clickable
            card.dataset.index = index;

            const genres = (movie.genres || '').split('|').filter(Boolean);
            const genrePills = genres.slice(0, 2).map(g =>
                `<span class="genre-pill">${g.trim()}</span>`
            ).join('');

            const simPercent = Math.round((movie.similarity_score || 0) * 100);

            card.innerHTML = `
                <div class="movie-card__poster-placeholder">🎬</div>
                <div class="movie-card__body">
                    <h3 class="movie-card__title">${ColdStartFlow.escapeHTML(movie.title)}</h3>
                    <div class="movie-card__genres">${genrePills}</div>
                    <div class="movie-card__meta-row">
                        <div class="movie-card__similarity">
                            <span>%${simPercent}</span>
                            <div class="similarity-bar">
                                <div class="similarity-bar__fill" style="width: 0%;" data-target="${simPercent}"></div>
                            </div>
                            <span>Benzerlik</span>
                        </div>
                        <div class="movie-card__rating" title="TMDB Puanı">
                            <i data-lucide="star" width="14" height="14"></i>
                            <span class="rating-value">-.-</span>
                        </div>
                    </div>
                </div>
            `;

            card.onclick = () => this.showModal(movie);

            return card;
        },

        showModal(movie) {
            const modal = document.getElementById('hologram-modal');
            if (!modal) return;
            
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
            title.textContent = (tmdbData && tmdbData.title) ? tmdbData.title : movie.title;
            poster.src = (tmdbData && tmdbData.posterUrl) ? tmdbData.posterUrl : '';
            poster.style.display = poster.src ? 'block' : 'none';
            
            // Render Genres
            let genrePills = '';
            let movieGenres = movie.genres || movie.genre || [];
            if (typeof movieGenres === 'string') {
                movieGenres = movieGenres.split(',').map(g => g.trim());
            }
            if (Array.isArray(movieGenres) && movieGenres.length > 0) {
                genrePills = movieGenres.map(g => `<span class="genre-pill">${g}</span>`).join('');
                genresContainer.innerHTML = genrePills;
                genresContainer.style.display = 'flex';
            } else {
                genresContainer.style.display = 'none';
            }
            
            let finalSynopsis = (tmdbData && tmdbData.overview) ? tmdbData.overview : (movie.overview || 'Bu film için özet bulunamadı.');
            
            // Canlı Çeviri (Live Translation)
            const translateSynopsis = async (text) => {
                if (text === 'Bu film için özet bulunamadı.') {
                    synopsis.textContent = text;
                    return;
                }
                
                if (tmdbData && tmdbData.overview_tr) {
                    synopsis.innerHTML = tmdbData.overview_tr;
                    return;
                }
                
                if (tmdbData && tmdbData.translationPromise) {
                    synopsis.innerHTML = '<span style="color: var(--ag-accent);"><i data-lucide="loader" class="spin"></i> Yapay Zeka çevirisi yapılıyor...</span>';
                    if (typeof lucide !== 'undefined') lucide.createIcons();
                    return; // Promise then bloğunda güncellenecek
                }
                
                synopsis.innerHTML = '<span style="color: var(--ag-accent);"><i data-lucide="loader" class="spin"></i> Yapay Zeka çevirisi yapılıyor...</span>';
                if (typeof lucide !== 'undefined') lucide.createIcons();
                
                const translated = await API.translateTextRaw(text);
                synopsis.innerHTML = translated;
            };
            
            translateSynopsis(finalSynopsis);
            
            // Show Modal
            modal.classList.remove('hidden');
            
            // Bind Close Event
            const closeModal = () => modal.classList.add('hidden');
            closeBtn.onclick = closeModal;
            closeBtn.onclick = closeModal;
            overlay.onclick = closeModal;
        },

        bindSortEvent() {
            const container = document.querySelector('.home-controls');
            if (container && !container.dataset.bound) {
                container.dataset.bound = "true";
                
                const buttons = container.querySelectorAll('.ag-filter-btn');
                buttons.forEach(btn => {
                    btn.addEventListener('click', (e) => {
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
                            sortedMovies.sort((a, b) => (b.similarity_score || 0) - (a.similarity_score || 0));
                        }
                        
                        // Ekranı temizle, kartları bas ve KAYBOLMAMALARI için animasyonu tekrar tetikle
                        this.render(sortedMovies);
                        this.animateCards();
                    });
                });
            }
        },



        /**
         * Load posters in sequential batches of 5 to avoid TMDB rate limiting
         */
        async loadPostersInBatches(cards) {
            const BATCH_SIZE = 5;
            const BATCH_DELAY = 200; // ms between batches

            for (let i = 0; i < cards.length; i += BATCH_SIZE) {
                const batch = cards.slice(i, i + BATCH_SIZE);

                // Load batch in parallel
                await Promise.allSettled(
                    batch.map(({ card, title }) => this.loadSinglePoster(card, title))
                );

                // Wait before next batch
                if (i + BATCH_SIZE < cards.length) {
                    await new Promise(r => setTimeout(r, BATCH_DELAY));
                }
            }
        },

        async loadSinglePoster(card, title) {
            try {
                const posterURL = await TMDBService.getPosterURL(title);
                
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
                        const img = document.createElement('img');
                        img.className = 'movie-card__poster';
                        img.src = posterURL;
                        img.alt = title;
                        img.loading = 'lazy'; // Performans Artışı: Tembel Yükleme
                        
                        // DOM'a eklenmeyen lazy resim yüklenmez. Bu yüzden anında değiştiriyoruz:
                        placeholder.replaceWith(img);
                    }
                }
            } catch (e) {
                // Ignore load errors in production
            }
        },

        animateCards() {
            const cards = DOM.movieGrid.querySelectorAll('.movie-card');

            if (typeof gsap !== 'undefined') {
                gsap.fromTo(cards,
                    { y: 60, opacity: 0, rotateX: -10 },
                    {
                        y: 0,
                        opacity: 1,
                        rotateX: 0,
                        stagger: 0.06,
                        duration: 0.5,
                        ease: 'back.out(1.2)',
                        clearProps: 'transform',
                    }
                );
            } else {
                cards.forEach((card, i) => {
                    setTimeout(() => {
                        card.style.opacity = '1';
                        card.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                        card.style.transform = 'translateY(0)';
                    }, i * 60);
                });
            }

            // PERF FIX: setTimeout ile similarity bar animasyonu ana thread zamanlamasına bağlandı.
            // GSAP delay kullanmak daha güvenilir frame zamanlaması sağlar.
            if (typeof gsap !== 'undefined') {
                gsap.to('.similarity-bar__fill', {
                    delay: 0.5,
                    duration: 0.8,
                    ease: 'power2.out',
                    width: function(i, el) {
                        return (el.dataset.target || 0) + '%';
                    }
                });
            } else {
                setTimeout(() => {
                    document.querySelectorAll('.similarity-bar__fill').forEach(bar => {
                        const target = bar.dataset.target || 0;
                        bar.style.width = `${target}%`;
                    });
                }, 500);
            }
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
                DOM.statusUsers.textContent = `Kullanıcı Sayısı: ${(data.total_users || 0).toLocaleString('tr-TR')}`;
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
        // 1. API Anahtarını backend'den (proxy üzerinden) güvenle çek
        try {
            const configData = await API.fetchJSON('/api/config');
            if (configData && configData.TMDB_API_KEY) {
                CONFIG.TMDB_API_KEY = configData.TMDB_API_KEY;
            }
        } catch (e) {
            console.error("Config yüklenemedi. TMDB aramaları çalışmayabilir.", e);
        }

        cacheDOMRefs();

        // Initialize Lucide icons
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }

        // Start flow
        await OnboardingController.init();

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
