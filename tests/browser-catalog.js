/* Local browser regression fixture; production never loads this file. */
(() => {
    const nativeFetch = window.fetch.bind(window);
    const reply = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json'}});
    const waitMs = ms => new Promise(resolve=>setTimeout(resolve,ms));
    const movies = Array.from({length:125}, (_,i)=>({movieId:1000+i,
        title:`${i<65?'Arşiv':'Film'} ${String(i+1).padStart(3,'0')} (2000)`,
        year:2000, genres:'Adventure|Drama', overview:'A traveller leaves home and learns a surprising truth.',
        tmdb_rating:i===119?7.2:4+(i%6), tmdb_votes:i+1}));
    const poster='/idqvLBmlEHUITMnQ0EJ6Yb5TpVw.jpg';
    const requests=[];
    let retryFails = true;
    let spanishRequested = false;
    let externalSynopsisRequests = 0;
    window.fetch = async (input, options={}) => {
        const url = new URL(input,location.href);
        if (url.pathname==='/health') return reply({total_movies:125,total_users:10});
        const synopsisRoute = url.pathname.match(/^\/movies\/(\d+)\/synopsis$/);
        if (synopsisRoute) {
            const movieId=Number(synopsisRoute[1]);
            const target=url.searchParams.get('language');
            if (target==='hi') return reply({},502);
            if (target==='es') {
                spanishRequested = true;
                await waitMs(450);
            }
            const text=target==='fr' ? 'Un voyageur découvre une vérité surprenante.'
                : target==='es' ? 'Un viajero descubre una verdad sorprendente.'
                : movieId===1000 || movieId===1119 ? 'Bir yolcu şaşırtıcı bir gerçeği öğrenir.' : 'Başka bir filmin özeti.';
            return reply({movieId,language:target,text});
        }
        if (url.pathname==='/api/movie-posters') {
            const movieId=Number(url.searchParams.get('movie_id'));
            return reply({poster_path:movieId===1016?null:poster,rating:7.2});
        }
        if (url.pathname==='/movies') {
            const q=url.searchParams.get('q')||'';
            const {sort,genre,year,min_rating}=Object.fromEntries(url.searchParams);
            requests.push({q,sort,genre,year,min_rating,page:Number(url.searchParams.get('page')),limit:Number(url.searchParams.get('limit'))});
            if(q==='retry' && retryFails) { retryFails=false; return reply({},500); }
            // Intentionally ignore AbortSignal to exercise the stale-response guard.
            await waitMs(q==='slow' ? 900 : 30);
            const filtered=movies.filter(m=>(q==='retry' || q==='slow' || m.title.toLowerCase().includes(q.toLowerCase()))
                && (!genre || m.genres.split('|').includes(genre)) && (!year || m.year===Number(year))
                && (!min_rating || m.tmdb_rating>=Number(min_rating)));
            if (sort==='rating-desc') filtered.sort((a,b)=>b.tmdb_rating-a.tmdb_rating || b.tmdb_votes-a.tmdb_votes);
            const totalPages=Math.ceil(filtered.length/30);
            const page=Math.max(1,Math.min(Number(url.searchParams.get('page')),totalPages||1));
            return reply({movies:filtered.slice((page-1)*30,page*30),page,total_pages:totalPages,
                total_movies:filtered.length,limit:30,rating_available:true});
        }
        if(url.hostname==='api.themoviedb.org' && url.pathname.endsWith('/translations')) {
            externalSynopsisRequests++;
            return reply({translations:[
                {iso_639_1:'tr',iso_3166_1:'TR',data:{overview:'Filmi çok beğendim, kesinlikle tavsiye ederim.'}},
            ]});
        }
        return nativeFetch(input,options);
    };
    const result={suite:'catalog',variant:'current',width:innerWidth,height:innerHeight,checks:{},errors:[]};
    window.addEventListener('error',event=>result.errors.push(event.message));
    window.addEventListener('unhandledrejection',event=>result.errors.push(String(event.reason)));
    const wait=async predicate=>{
        const deadline=performance.now()+15000;
        while(!predicate()) { if(performance.now()>deadline) throw new Error('Catalogue wait timed out'); await waitMs(25); }
    };
    const search=async query=>{
        const input=document.getElementById('catalog-search');
        input.value=query;
        input.dispatchEvent(new Event('input',{bubbles:true}));
        await waitMs(350);
        await wait(()=>document.getElementById('catalog-grid').getAttribute('aria-busy')==='false');
    };
    window.addEventListener('load',async()=>{
        try {
            await wait(()=>window.__cineflowTest);
            await waitMs(350);
            const {STATE,HomeRenderer:home,ViewManager:views}=window.__cineflowTest;
            const recommendations=movies.slice(0,3).map(m=>({...m,similarity_score:.8,
                overview:'Filmi çok beğendim, kesinlikle tavsiye ederim.'}));
            // Seed the real recommendation view without making unrelated cold-start requests.
            await Promise.all(recommendations.map(async movie=>{
                STATE.tmdbCache[movie.title.toLowerCase()]={posterUrl:'https://image.tmdb.org/t/p/w500'+poster,
                    rating:7.2};
            }));
            await home.render(recommendations);
            views.showHome(); home.animateCards();
            const recommendationNodes=[...document.getElementById('movie-grid').children];
            document.querySelector('#movie-grid .movie-card').click();
            const synopsis=document.querySelector('.hologram-modal__synopsis');
            await wait(()=>synopsis.textContent==='Bir yolcu şaşırtıcı bir gerçeği öğrenir.');
            result.checks.archiveSynopsisUsed=externalSynopsisRequests===0;
            document.querySelector('.hologram-modal__close').click();
            document.querySelector('.nav__link[data-view="catalog-view"]').click();
            const grid=document.getElementById('catalog-grid');
            await wait(()=>grid.querySelectorAll('.movie-card').length===30 && grid.getAttribute('aria-busy')==='false');
            result.checks.pageOne30=grid.children.length===30;
            result.checks.localIds=[...grid.children].every(c=>Number(c.dataset.movieId)>=1000 && Number(c.dataset.movieId)<1125);
            result.checks.noSimilarityScores=!grid.querySelector('.movie-card__similarity');
            result.checks.pagesOneToFive=[...document.querySelectorAll('#catalog-pages button')].map(b=>b.textContent).join(',')==='1,2,3,4,5';
            result.checks.previousDisabled=document.getElementById('catalog-prev').disabled;
            document.querySelector('#catalog-pages [aria-label="2. sayfa"]').click();
            await wait(()=>grid.querySelector('.movie-card')?.dataset.movieId==='1030');
            result.checks.pageTwo30=grid.children.length===30;
            result.checks.pageTwoActive=document.querySelector('#catalog-pages [aria-current="page"]').textContent==='2';
            document.querySelector('#catalog-pages [aria-label="5. sayfa"]').click();
            await wait(()=>grid.querySelector('.movie-card')?.dataset.movieId==='1120');
            result.checks.lastPage5=grid.children.length===5;
            result.checks.nextDisabled=document.getElementById('catalog-next').disabled;
            await search('Arşiv');
            result.checks.searchWholeDataset=grid.children.length===30 && document.getElementById('catalog-status').textContent.includes('65 sonuç');
            result.checks.searchResetsPage=document.querySelector('#catalog-pages [aria-current="page"]').textContent==='1';
            document.querySelector('#catalog-pages [aria-label="3. sayfa"]').click();
            await wait(()=>grid.querySelector('.movie-card')?.dataset.movieId==='1060');
            result.checks.searchPageThree5=grid.children.length===5;
            await search('missing-film');
            result.checks.emptyState=grid.textContent.includes('bulunamadı') && document.getElementById('catalog-pagination').hidden;
            await search('retry');
            result.checks.errorState=!!grid.querySelector('.catalog-retry');
            grid.querySelector('.catalog-retry').click();
            await wait(()=>grid.querySelectorAll('.movie-card').length===30);
            result.checks.retryWorks=true;
            const input=document.getElementById('catalog-search');
            input.value='slow';
            document.getElementById('catalog-search-form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
            await waitMs(60);
            await search('Film 120');
            await waitMs(1000);
            result.checks.staleSearchIgnored=grid.children.length===1 && grid.querySelector('.movie-card').dataset.movieId==='1119';
            grid.querySelector('.movie-card').click();
            await wait(()=>synopsis.textContent==='Bir yolcu şaşırtıcı bir gerçeği öğrenir.');
            result.checks.localModalTitle=document.querySelector('.hologram-modal__title').textContent===movies[119].title;
            result.checks.localModalSynopsis=true;
            await wait(()=>document.querySelector('#hologram-modal .film-detail-rating').textContent==='7.2 / 10');
            result.checks.detailsRating=true;
            const languages=document.getElementById('summary-language-options');
            result.checks.tenSummaryLanguages=languages.children.length===10;
            languages.querySelector('[lang="es"]').click();
            await wait(()=>spanishRequested);
            languages.querySelector('[lang="fr"]').click();
            await wait(()=>synopsis.textContent==='Un voyageur découvre une vérité surprenante.');
            await waitMs(550);
            result.checks.lateTranslationIgnored=synopsis.lang==='fr' && synopsis.textContent==='Un voyageur découvre une vérité surprenante.';
            languages.querySelector('[lang="hi"]').click();
            await wait(()=>synopsis.textContent==='हिन्दी सारांश अभी उपलब्ध नहीं है।');
            result.checks.translationFailureIsLocalized=synopsis.lang==='hi' && !synopsis.textContent.includes(movies[119].overview);
            languages.querySelector('[lang="tr"]').click();
            await wait(()=>synopsis.textContent==='Bir yolcu şaşırtıcı bir gerçeği öğrenir.');
            document.querySelector('.hologram-modal__close').click();
            document.querySelector('.nav__link[data-view="home-view"]').click();
            result.checks.recommendationsPreserved=STATE.currentRecommendations===recommendations && recommendationNodes.every((c,i)=>document.getElementById('movie-grid').children[i]===c);
            document.querySelector('.nav__link[data-view="catalog-view"]').click();
            await wait(()=>grid.querySelector('.movie-card')?.dataset.movieId==='1119');
            result.checks.searchPreserved=input.value==='Film 120';
            document.getElementById('catalog-clear').click();
            await wait(()=>grid.querySelectorAll('.movie-card').length===30);
            await wait(()=>grid.querySelector('[data-movie-id="1016"] .movie-card__poster-placeholder')?.textContent==='Poster bulunamadı');
            result.checks.missingPosterKept=grid.children.length===30;
            const filters=document.getElementById('catalog-filter-form');
            const filterButton=document.getElementById('catalog-filter-button');
            const filterDialog=document.getElementById('catalog-filter-dialog');
            const chips=document.getElementById('catalog-active-filters');
            filterButton.click();
            await wait(()=>filterDialog.open);
            const panel=filters.getBoundingClientRect();
            result.checks.filterPanelFits=panel.left>=0 && panel.right<=innerWidth;
            result.checks.filterDialogFocus=document.activeElement.id==='catalog-filter-close';
            filters.elements.namedItem('sort').value='rating-desc';
            filters.requestSubmit();
            await wait(()=>grid.querySelector('.movie-card')?.dataset.movieId==='1113');
            result.checks.archiveSort=grid.querySelector('.rating-value').textContent==='9.0'
                && document.getElementById('catalog-filter-count').textContent==='1';
            result.checks.filterDialogCloses=!filterDialog.open && document.activeElement===filterButton;
            document.querySelector('#catalog-pages [aria-label="2. sayfa"]').click();
            await wait(()=>document.querySelector('#catalog-pages [aria-current="page"]')?.textContent==='2');
            result.checks.sortPreservedOnPageTwo=requests.at(-1).sort==='rating-desc';
            filterButton.click();
            filters.elements.namedItem('genre').value='Drama';
            filters.elements.namedItem('year').value='2000';
            filters.elements.namedItem('min_rating').value='8';
            filters.requestSubmit();
            await wait(()=>grid.querySelector('.movie-card')?.dataset.movieId==='1113');
            await search('Arşiv');
            result.checks.searchAndFiltersCombine=grid.querySelector('.movie-card')?.dataset.movieId==='1059'
                && requests.at(-1).min_rating==='8' && requests.at(-1).genre==='Drama' && requests.at(-1).year==='2000';
            chips.querySelector('[aria-label="2000 seçimini kaldır"]').click();
            await wait(()=>grid.querySelector('.movie-card')?.dataset.movieId==='1059' && requests.at(-1).year===undefined);
            result.checks.individualFilterRemoval=chips.querySelectorAll('.catalog-filter-chip').length===3
                && requests.at(-1).genre==='Drama' && requests.at(-1).min_rating==='8';
            filterButton.click();
            filters.elements.namedItem('sort').value='archive';
            filterDialog.dispatchEvent(new Event('cancel',{cancelable:true}));
            filterButton.click();
            result.checks.cancelDiscardsDraft=filters.elements.namedItem('sort').value==='rating-desc';
            document.getElementById('catalog-filter-reset').click();
            await wait(()=>grid.querySelector('.movie-card')?.dataset.movieId==='1000');
            result.checks.filterResetKeepsSearch=input.value==='Arşiv' && document.getElementById('catalog-filter-count').hidden;
            document.getElementById('catalog-clear').click();
            await wait(()=>grid.children.length===30 && grid.getAttribute('aria-busy')==='false');
            await wait(()=>!grid.classList.contains('is-animating'));
            result.checks.allCardsVisible=[...grid.children].every(c=>Number(getComputedStyle(c).opacity)===1);
            result.checks.noHorizontalOverflow=document.documentElement.scrollWidth<=innerWidth;
            const columns=getComputedStyle(grid).gridTemplateColumns.split(' ').length;
            result.checks.responsiveColumns=columns===(innerWidth<600?2:innerWidth<1024?3:5);
            result.checks.requestsArePaginated=requests.every(r=>r.limit===30);
            result.requests=requests;
        } catch(error) { result.errors.push(String(error)); }
        await nativeFetch('/results',{method:'POST',body:JSON.stringify(result)});
        const output=document.createElement('pre'); output.id='test-results'; output.textContent=JSON.stringify(result,null,2);
        output.style.cssText='position:relative;padding:24px;background:#111;color:white;white-space:pre-wrap';
        document.body.append(output);
        document.title=result.errors.length || Object.values(result.checks).some(value=>!value)
            ? 'Catalogue tests failed' : 'Catalogue tests complete';
    });
})();
