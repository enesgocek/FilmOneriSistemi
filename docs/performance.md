# CineFlow animasyon performansı

## Korunan görsel davranış

- Masaüstünde 10 gerçek posterli yelpaze dağıtımı, mobil genişlikte şelale dağıtımı.
- Mevcut hareket mesafeleri, süreler, stagger aralıkları ve easing eğrileri.
- 3D kart çevirme, kaydırma, portal, cam efektleri, gölgeler ve arka plan ışıkları.
- Posterler için mevcut TMDB `w500` çözünürlüğü.

Sürüklemeden geri dönen kartın animasyonunu kesen doğrudan `transform` ataması kaldırıldı. Bu düzeltme mevcut 0,4 saniyelik geri dönüş hareketinin gerçekten oynatılmasını sağlar.

## Yapılan düzenlemeler

1. GSAP hareketi sırasında aynı özellikleri yeniden yumuşatan CSS geçişleri durdurulur; hover geçişleri animasyon sonrasında devam eder.
2. İlk film verisi geldiği anda gerçek kart görselinin indirilmesi/decode işlemi başlatılır. Aynı `Image` kartta kullanılır. Başarısız/yavaş resimlerin akışı sonsuza kadar bekletmemesi için görsel başına 8 saniyelik üst bekleme sınırı vardır; bu sınır internet isteğini iptal etmez.
3. Öneri metaverisi en fazla 4 eşzamanlı işlemle hazırlanır. İlk 10 öneri posteri giriş öncesinde hazırlanır; diğerleri native lazy loading kullanır. Hazırlanan görsel kart tarafından alındığında geçici havuzdan çıkarılır.
4. Dağıtım boyunca yalnızca görünen ön yüz işlenir; etkileşim başlamadan 3D yapı geri gelir. Dağıtım sonrası gizli kartlar çizim ağacından çıkarılır, sıraya geldiklerinde geri alınır. `will-change` tüm gizli destede sürekli tutulmaz.
5. Benzerlik çubuğunun hedef genişliği bir kez belirlenir, dolma hareketi `scaleX` ile yapılır. Gradient, hedef yüzde, süre ve easing korunur.
6. Sıralamada mevcut kartlar ve resimler yeniden kullanılır. Eski stagger animasyonunun ana tween'i, alt tween'leri, bekleyen kare ve fallback zamanlayıcıları iptal edilir. Eski render'ın geç tamamlanması yeni sıralamayı başlatamaz.
7. Kart ve buton dinleyicileri yeniden başlatmada tamamen kaldırılır. Sürükleme hedefleri başlangıçta tutulur; hareket başına tekrar DOM araması yapılmaz. Bekleyen sürükleme karesi bırakma/iptalde temizlenir; ikinci parmak, pointer iptali ve pencere odağı kaybı ele alınır.
8. Ekran boyutu/çekirdek sayısı nedeniyle modern telefonlarda otomatik efekt kaldırılması sonlandırıldı. Mevcut iOS 13 ve öncesi uyumluluk yolu korundu; bu cihazlarda hâlâ daha basit efektler kullanılır. Gerçek eski Safari cihazı doğrulanmadan bu uyumluluk yolu kaldırılmamalıdır.

Backend öneri algoritması, veri dosyaları ve HTML tasarımı bu çalışmada değiştirilmedi.

## Tekrarlanabilir tarayıcı testi

Proje kökünde:

```powershell
node --check static/app.js
node --check tests/browser-performance.js
.\.venv\Scripts\python.exe tests/performance_server.py
```

Tarayıcıda `http://127.0.0.1:8010/current/` adresini açın. Test otomatik ilerler; bittiğinde sayfanın sonuna sonuçlar eklenir. Sonuç dosyaları `tmp/performance/current-desktop-results.json` ve `current-mobile-results.json` altında tutulur. Test sunucusu sadece loopback adresinde dinler ve üretim uygulamasından bağımsızdır.

Test, sabit 10 başlangıç filmi ve 30 öneri kullanır. API/çeviri yanıtları yerel fixture'dır; API anahtarı okunmaz. Gerçek poster dosyaları, fontlar, GSAP ve ikonlar CDN'den gelir. Karşılaştırmada indirme değişkenliğini azaltmak için poster önbelleği ısıtılır. Bu nedenle test soğuk ağ yükleme performansını ölçmez.

Karşılaştırma için değişiklik öncesi `static` dosyalarını önceden `tmp/performance/baseline/static/` altına kopyalayın ve `http://127.0.0.1:8010/baseline/` adresini açın. Bu çalışmanın başlangıç kopyası bu konumda bırakılmıştır; Git'e eklenmez.

Testler: 10 kart/3 görünür kart, poster hazırlığı, iki yönde flip, sürükleme geri dönüşü/iptali, tek karar, 30 öneri, puan sıralaması, kart nesnelerinin yeniden kullanımı, animasyon sürerken yeniden sıralama, benzerlik çubukları, dinleyici sayıları, modal ve tam yeniden başlatma.

## Ölçüm sınırları ve kabul standardı

Bu ortamda Chromium tabanlı uygulama içi tarayıcıda 1280×720 ve 390×844, DPR 1 ile kontrol yapılır. Dar pencere testi gerçek Android/iPhone donanımı, yüksek DPR veya Safari testi değildir.

`requestAnimationFrame` aralıkları, 33,4 ms üzerindeki aralıklar ve 50 ms üzerindeki ana iş parçacığı görevleri raporlanır. Bunlar ekrana gerçekten sunulmuş GPU karelerini saymaz. Yüksek yenileme hızlı monitörde 16,7 ms altı örnekler normaldir. Arka plan yükü, pencere görünürlüğü ve güç durumu sonuçları etkiler; tek koşudan genel bir FPS artış oranı çıkarmayın.

60 Hz cihazlarda hedef yaklaşık 16,7 ms kare bütçesi, mümkün olduğunca az 33,4 ms üzeri takılma ve animasyon sırasında uzun ana iş parçacığı görevlerinin olmamasıdır. Bu bir tüm cihazlarda 60 FPS garantisi değildir. Yayın öncesi gerçek Android Chrome ve iPhone Safari üzerinde aynı akışların, soğuk/sıcak önbelleğin ve 2×/3× DPR'nin kontrol edilmesi gerekir.

Başlangıç testinde GSAP girişi sırasında aktif CSS `transform` geçişleri ve yeniden bağlamada 4'e çıkan dinleyiciler gözlendi. Düzeltilmiş sürümde bu kontrollerin beklenen değeri sırasıyla 0 ve 1'dir; sıralama kart kimliklerini korumalı, tüm fonksiyonel kontroller `true`, hata listesi boş olmalıdır.

### 18 Kasım 2026 son doğrulama

Son kaynak kodla her iki genişlikte bütün fonksiyonel kontroller geçti. Normal ve hızlı sıralamada çakışan CSS transform geçişi 0, yeniden başlatma sonrasında da her giriş dinleyicisinin sayısı 1, JavaScript hata listesi boş.

| Ölçülen aşama | Masaüstü p95 kare aralığı | Dar ekran p95 kare aralığı |
| --- | ---: | ---: |
| Portal ve deste girişi | 16,7 ms | 16,7 ms |
| Kart çevirme | 11,1 ms | 11,2 ms |
| Kartı geri çevirme | 6,7 ms | 11,1 ms |
| Kaydırma | 16,6 ms | 11,5 ms |
| Öneri kartlarının girişi | 11,3 ms | 11,2 ms |
| Sıralama | 16,7 ms | 11,3 ms |

Bu son koşularda kaydedilen 50 ms üzeri ana iş parçacığı görevi yoktu. 33,4 ms üzeri kare aralığı toplamı masaüstünde 3, dar ekranda 2 idi. Önceki tekrarlar değişken sonuç verdiği için bu tablo genel bir hızlanma yüzdesi veya her cihaz için garanti olarak kullanılmamalıdır. Ham yerel sonuçlar `tmp/performance/` altındadır.
