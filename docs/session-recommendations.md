# Oturum bazlı film önerileri

1. Kullanıcı yıl aralığını seçer, ardından istediği kadar türü işaretler.
2. Kartlar yıl aralığına ve seçilen türlerden en az birine uyar. Tür seçilmezse bütün türler değerlendirilir.
3. On karta kadar film değerlendirildikten sonra film kimlikleri, beğeni ve geçme kararlarıyla birlikte sunucuya gönderilir.
4. Önerilerde aynı yıl ve tür koşulları uygulanır. **25 farklı uygun film** varsa 25 öneri gösterilir. Daha az uygun kayıt varsa sonuç sayısı ekranda belirtilir.

## Öneri sırası nasıl oluşuyor?

Önceki 384 boyutlu konu vektörleri korunur. Bir beğeni için üç aday havuzu hazırlanır. Konu havuzu kosinüs benzerliğini, tür havuzu ortak etiketleri, başrol havuzu ortak TMDB oyuncu kimliklerini kullanır. Başrol sinyali bir filmin künyesinde ilk üç sıradaki oyuncuya dayanır. Oy sayısına göre dengelenmiş arşiv puanı sıralamaya küçük bir katkı verir.

Beğeniler tutarlı bir kimlik sırasıyla topluca değerlendirilir. Daha önce değerlendirilen film kimlikleri ve aynı başlıklar listeden çıkarılır. Geçilen filme açıkça daha yakın olan adaylar küçük bir puan düşüşü alır.

Güçlü konu eşleşmesi listenin başında kalır. Farklı beğenilerin konu, tür ve başrol adayları sıraya karışır. Birbirine yakın puanlı adaylar arasında oturuma göre seçim yapılır. Kullanıcı **Yeni karışım** dediğinde aynı seçimlerle, önceki listede görünmeyen yakın adaylara öncelik verilir.

Önce güçlü adaylar sunulur. 25'e ulaşmak için gerekirse aynı aralıktaki daha genel adaylar **Keşif seçkisi** olarak eklenir. Tüm kartlar geçildiğinde de bu etiket kullanılır. Kartın ayrıntısındaki **Neden önerildi?** alanı eşleşen film, oyuncu veya türü açıklar.

Bu düzen, Netflix'in yayımladığı birden fazla tercih ve yapım sinyalini kullanma yaklaşımından yararlanır. CineFlow'daki doğrudan sinyaller bu oturumun kart kararlarıdır. [Netflix öneri sistemi](https://help.netflix.com/en/node/100639/)

## Oyuncu dizini

```powershell
.\.venv\Scripts\python.exe scripts/setup_recommendation_cast.py
```

Betiğin ürettiği `data/recommendation_cast.json` sunucu başlangıcında okunur. Film kimliği ve başlığı MovieLens üzerinden kontrol edilir. Başrol verisi, TMDB'den derlenmiş [The Movies Dataset](https://www.kaggle.com/datasets/rounakbanik/the-movies-dataset) kadro aktarımından gelir. Bu arşivde başrol dizini aktif 46.528 filmin 30.637'sini kapsıyor. Kadro verisi bulunmayan filmler için konu ve tür havuzları çalışır. Yerel arşivde yılı bilinen en yeni film 2019 tarihlidir.

## Doğrulama

```powershell
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
node tests/audit_recommendation_flow.js
```

Vakalar, sıra bağımsızlığını, güçlü eşleşmenin yeni karışımda korunmasını, aynı başrolün kimlikle doğrulanmasını, yıl ve tür filtrelerinin birlikte uygulanmasını, hiç beğeni olmamasını ve 25 aday bulunamayan aralıkları kapsar.
