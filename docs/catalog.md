# Tüm Filmler kataloğu

Öneriler ekranındaki navbar üzerinden açılır. Önerilere dönüldüğünde beğeniler, öneri kartları ve sıralama korunur. Katalogdaki arama ve sayfa seçimi de gezinme sırasında korunur; Yeniden Keşfet yeni oturum başlatır.

- Film listesi yalnızca uygulamanın belleğe yüklediği yerel `DATA_STORE['df_movies']` veri kümesinden gelir. Dönem seçimi kataloğu kısıtlamaz.
- Her sayfada 30 kayıt bulunur; son sayfa kalan kayıtları gösterir. İlk kontrol edilen gerçek veri kümesi: 46.528 kayıt, 1.551 sayfa, son sayfada 28 kayıt.
- Altta Önceki / numaralı sayfalar / Sonraki bulunur. İlk beş sayfa başlangıçta görünür; uzak sayfalarda aktif sayfanın çevresindeki beş sayfa, ilk ve son sayfa gösterilir.
- Arama tüm yerel veri kümesinde film adına göre yapılır. Büyük/küçük harf, aksan ve Türkçe I/İ/ı farkları normalize edilir. Regex uygulanmaz.
- Filtrele panelinde TMDB puanı, oy sayısı, çıkış yılı ve film adına göre sıralama yapılır. Tür, çıkış yılı ve minimum puan birlikte seçilebilir. Arama, filtreleme ve sıralama önce sunucuda uygulanır, ardından sayfa alınır.
- Arama 300 ms yazma aralığından sonra veya Ara/Enter ile yapılır; yeni arama 1. sayfadan başlar. Eski yanıtlar yeni aramayı değiştiremez.
- TMDB mevcut yerel kayıtların poster ve puanlarını tamamlar. Kart arkası ve film detayındaki özet, yerel film kimliğiyle arşivden alınır ve seçilen dile çevrilir. Çeviri öncesi ve sonrası yer tutucular ve belirgin izleyici yorumu kalıpları elenir. Posteri veya puanı olmayan kayıtlar listeden çıkarılmaz.
- Katalogda kişiselleştirilmiş benzerlik yüzdesi gösterilmez; yıl ve mevcutsa TMDB puanı gösterilir.
- Tasarım mevcut film kartlarını, detay modalını, cam yüzeyleri, renkleri ve giriş hareketini kullanır.
- 600 px altı: 2 sütun; 600–1023 px: 3 sütun; 1024 px ve üzeri: 5 sütun.

## API

`GET /movies?page=1&limit=30&q=matrix`

Yanıt: `page`, `total_pages`, `total_movies`, `limit`, `movies`.

`total_movies` arama varsa eşleşen yerel kayıt sayısıdır. Boş aramada tüm kayıtlar listelenir. Sonuç yoksa `movies: []`, `total_pages: 0`, `page: 1` döner. Son sayfadan büyük geçerli bir sayfa isteği son sayfaya sabitlenir. API'nin mevcut varsayılan limit değeri 50 olarak korunmuştur; katalog açıkça 30 ister. Mevcut `/search` autocomplete uç noktası değiştirilmemiştir.

`GET /movies?page=1&limit=30&sort=rating-desc&genre=Drama&year=1999&min_rating=7`

`total_movies` seçilen filtreleri de hesaba katar. `rating_available` puan dizininin kullanılabilirliğini gösterir. `tmdb_rating` ve `tmdb_votes` yerel dizindeki puan ve oy sayısıdır. Puanı olmayan filmler her iki puan sıralamasında da sonda yer alır.

## TMDB puan dizini

```powershell
.\.venv\Scripts\python.exe scripts/setup_catalog_ratings.py
```

Hazırlama betiği [MovieLens 25M](https://grouplens.org/datasets/movielens/25m/) kimlik eşlemelerini ve [TMDB puan anlık görüntüsünü](https://huggingface.co/datasets/ada-datadruids/full_tmdb_movies_dataset) kullanır. Yerel kimlik ve başlık eşleşmesi kontrol edilir. `data/catalog_tmdb_ratings.csv` yalnızca eşleşen yerel film kimliği, puanı ve oy sayısını içerir. Yeni ortamda oluşturduktan sonra sunucuyu başlatın. Dizin yoksa arama, tür, yıl ve başlık sıralaması çalışır. Puan seçenekleri dizin yüklenince etkinleşir.

## Doğrulama

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p test_catalog.py
node --check static/app.js
node --check tests/browser-catalog.js
.\.venv\Scripts\python.exe tests/performance_server.py
```

Tarayıcıda `http://127.0.0.1:8010/current/?suite=catalog` açıldığında sabit yerel fixture ile UI testleri otomatik çalışır. Sonuçlar sayfanın sonunda ve `tmp/performance/catalog-current-*-results.json` içinde görünür. Fixture sunucusu gerçek API anahtarı kullanmaz, üretimde çalışmaz.

Kontroller: 30 kayıt, yerel kayıt kimlikleri, 1–5 sayfa düğmeleri, ilk/son sayfa sınırları, arama sonuçlarında sayfalama, boş sonuç, hata/yeniden deneme, geç gelen yanıtların elenmesi, yerel modal içeriği, önerilerin korunması, postersiz kayıtların korunması, sütun sayısı ve yatay taşma.

18 Kasım 2026 doğrulaması: backend birim testlerinin beşi ve 390 px mobil katalog testinin 25 kontrolü geçti. Gerçek API'de ilk, ikinci ve son sayfalar ile arama doğrulandı. 768 px genişlikte üç sütun ve yatay taşma olmaması kontrol edildi. Uygulama içi tarayıcıdaki son tekrar animasyonun tamamlanmasını beklerken zaman aşımına girdi; bu ortamın sonuçları FPS garantisi olarak kullanılmamalıdır. `tmp/performance/catalog-mobile-preview.png` ekran görüntüsü test kayıtlarını gösterir.
