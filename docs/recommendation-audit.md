# CineFlow öneri sistemi denetimi

18 Kasım 2026

Bu rapor, oturum bazlı öneri motoru uygulanmadan önceki davranışı kaydeder. [Güncel akış ve testler](session-recommendations.md).

**Karar:** Kart kararları, benzer film araması ve sonuç ekranı normal akışta çalışıyor. Öneri motoru ağırlıklı olarak vektör benzerliği kullanıyor. Kullanıcının türü, başrolü veya konuyu neden beğenmiş olabileceğini ayrı ayrı değerlendirip birleştiren kişiselleştirme henüz yok.

## Doğrulanan akış

1. Tarayıcıda 10 gerçek film kartıyla test yapıldı. *Arjun (1985)* ve *Crime on a Summer Morning (1965)* beğenildi. Diğer sekiz kart geçildi.
2. İki filmin `/similar` yanıtları ayrı ayrı yeniden alındı. Her biri 15 aday verdi. Tarayıcıdaki 30 kartın kimlikleri ve sırası, bu iki listenin ön yüzde birleştirilmesiyle birebir eşleşti. Değerlendirilen 10 film bu oturumun önerilerinde görünmedi.
3. Üretim JavaScript mantığı kontrollü ağ yanıtlarıyla da çalıştırıldı. Hızlı ikinci tıklama ilk kararı çoğaltmadı. Gerçek katalogdan 12 ayrı beğeni/geçme senaryosunda yıl sınırı, azami 30 aday, liste sırası ve değerlendirilmiş başlıkların çıkarılması doğrulandı.
4. Dört dönem seçeneği için 24'er başlangıç isteği çalıştırıldı. 96 denemenin tamamında API 10 farklı film kimliği döndürdü ve uygulanan yıl sınırları korundu. Tarayıcıdaki poster kontrolü bu sayıyı daha sonra düşürebiliyor.

## Önerilerin ilgisi

| Sinyal | Ölçüm | Yorum |
| --- | --- | --- |
| Tür | 8 türden 12'şer film ile 96 başlangıç filmi ve 960 ilk 10 önerisi incelendi. En az bir ortak tür %65,5, rastgele arşiv seçimi için beklenen oran %33,6. Örneklemin seçildiği belirli tür %44,8, rastgele baz %15,3. | Vektörler tür ilişkisini kısmen yakalıyor. Sıralamada ayrı bir tür ağırlığı bulunmuyor. |
| Konu | *Toy Story* için ilk üç aday serinin diğer üç filmi. *The Conjuring* için ilk öneriler doğaüstü olay ve perili ev temalarını yakalıyor. *Titanic* için ilk üç adayın özetinde Rose adında bir karakter var; gemi yolculuğunu konu alan *Titanic (1953)* dördüncü. *Inception* için *Working Girl* ikinci sırada. | Konu isabeti örneğe göre değişiyor. Özetlerdeki ortak adlar veya olay parçaları, aranan genel hikâyeyi tek başına temsil etmiyor. |
| Başrol | 4 film için ilk sıradaki oyuncu TMDB'den doğrulandı. İlk 10'ar adayın toplamında aynı oyuncu 40 filmin yalnızca 1'inde yer aldı. | Arşiv şemasında oyuncu kadrosu alanı ve sıralamada oyuncu kimliği sinyali yok. |

Tür baz çizgisi, her başlangıç filmi için arşivden başka bir film rastgele seçildiğinde beklenen eşleşme oranıdır. Bu ölçümler kullanıcının öneriyi beğenme olasılığını ölçmez. Konu örnekleri yerel özetler üzerinden niteliksel olarak incelendi.

| Başlangıç filmi | TMDB'de ilk sıradaki oyuncu | İlk 10 adayda aynı oyuncu |
| --- | --- | ---: |
| The Matrix (1999) | Keanu Reeves | 1 (*The Matrix Reloaded*) |
| Forrest Gump (1994) | Tom Hanks | 0 |
| The Devil Wears Prada (2006) | Meryl Streep | 0 |
| Interstellar (2014) | Matthew McConaughey | 0 |

Oyuncu doğrulaması, MovieLens film kimlikleri TMDB kimliklerine eşlenerek yapıldı. [TMDB film kadrosu belgeleri](https://developer.themoviedb.org/reference/movie-credits) · [MovieLens 25M kimlik açıklaması](https://files.grouplens.org/datasets/movielens/ml-25m-README.html)

## Doğrulanan sorunlar

| Önem | Bulgu | Etki |
| --- | --- | --- |
| Yüksek | Aynı aday iki beğeniden gelirse ilk karşılaşılan puan korunuyor. 45 film çifti arasında 2 çiftte puan ve sıralama değişti. Örneğin *The Matrix* ve *Inception* ters sırada beğenilince *Sneakers* 4. sıradan 18. sıraya indi. | Kullanıcı aynı filmleri beğense bile sıraya bağlı farklı öneriler alabiliyor. |
| Yüksek | Beğeni varsa geçilen film yalnızca tam başlık eşleşmesiyle çıkarılıyor. Kontrollü bir senaryoda bir aday geçildiğinde, kalan 14 adayın puan ve sırası aynen kaldı. | Geçilen filmler, benzer adayları aşağı indiren bir tercih sinyali oluşturmuyor. |
| Yüksek | Kullanıcı tüm kartları geçerse motor yeni rastgele bir deste alıyor. Kontrollü tekrar örneğinde aynı on film yeniden döndü ve her birine sabit `0.5` benzerlik verildi. | Daha önce geçilmiş film dönebilir. Ekrandaki %50 değeri ölçülmüş bir kişisel eşleşme değil. |
| Yüksek | Poster kaynağının eksikliği adayları eliyor ve boşalan yerler doldurulmuyor. Kontrollü 15 aday örneğinde iki geçerli posterle yalnızca 2 kart, sağlayıcı tümüyle yoksa 0 kart çıktı. | Öneri isabeti veya liste uzunluğu, film verisinin yanında harici poster erişimine de bağlı. |
| Orta | 79 film başlığı birden çok kimlikle eşleşiyor. `Aladdin (1992)` kimlikleri 588 ve 114240. Başlıkla arama 588'i seçiyor. | Başlangıç kartı 114240 olsa bile beğeni yanlış filme bağlanabilir. |
| Orta | Boş `movie_title` yaşayan API'de *Toy Story* sonucuna gitti. Verisi olmayan 2022–2026 ve ters 2015–1990 yıl aralıkları 500 döndü. `count=20` kabul edildi ancak 15 kart döndü. | Beklenmeyen girdiler açık hata mesajı veya güvenli boş sonuç üretmiyor. |
| Orta | Kaynak dosyada 56.819 film var. En az 23 kelimelik özet şartı sonrası 46.528 film kalıyor. *John Wick (2014)* 17 kelimelik özeti nedeniyle erişilemezken devam filmleri mevcut. Yılı bilinen en yeni film 2019 tarihli. | “2010–2026” seçeneği mevcut arşivde 2020 sonrası bir film sunamıyor. Kısa özeti olan bilinen filmler de kaybolabiliyor. |

`/recommendations/{user_id}` uç noktası 162.541 kullanıcı için önceden üretilmiş bir tablo sunuyor. Kart kaydırma akışı bu uç noktayı çağırmıyor. Bu akışta yalnızca beğenilen filmler için `/similar` kullanılıyor.

Arşivdeki 46.528 adet 384 boyutlu vektörün tamamı sonlu ve sıfırdan farklı. Vektörlerin üretim kodu çalışma alanında bulunmadığı için eğitim girdilerinin tam içeriği doğrulanamadı. Çalışan sıralama kodunda kosinüs puanına oyuncu, tür veya olumsuz tercih katkısı eklenmediği doğrudan görüldü. Ekranda gösterilen kosinüs puanı, kullanıcının filmi beğenme olasılığı olarak kalibre edilmiş değil.

## Düzeltme önceliği

1. Beğeni ve geçme kararlarını film kimliğiyle tek öneri isteğinde değerlendir. Adayları beğeni sırasından bağımsız puanla. İzlenen kartları her durumda çıkar ve poster eksik olduğunda geçerli adaylarla listeyi tamamla.
2. Yerel filme bağlı TMDB oyuncu kimlikleri ve tür verisi ekle. Konu, tür ve ilk sıradaki oyuncuların benzerliğini ayrı hesapla. Tek bir sağ kaydırma hangi özelliğin beğenildiğini kesin olarak söylemediği için farklı sinyallerden aday sun.
3. Uygun önerilere anlamlı bir neden göster. Örneğin “Aynı başrol” veya “Benzer konu”. Sonuçları etiketli senaryolarla tekrar ölç ve yıl aralığını güncel arşiv kapsamına bağla.

## Tekrar çalıştırma

```powershell
.\.venv\Scripts\python.exe tests/audit_recommendations.py
.\.venv\Scripts\python.exe tests/audit_recommendation_credits.py
```

Oyuncu karşılaştırması için mevcut TMDB yapılandırması ve ağ erişimi gerekir. Ham ölçümler `tmp/recommendation-audit/` altında yer alır. Gerçek tarayıcı oturumu `live-browser.json`, onun API ile karşılaştırması `live-comparison.json` dosyasındadır. Önceki sürümün karar birleştirme ölçümü `frontend.json` olarak kaydedilmiştir.
