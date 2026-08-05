# CineFlow — Sinematik Evrenini Keşfet 🎬

CineFlow, modern bir 3 Boyutlu (3D) web arayüzüne ve yapay zeka tabanlı (Vektör Benzerliği) bir film öneri motoruna sahip, elit ve yepyeni bir film keşif platformudur. 

<img width="1536" height="693" alt="Screenshot 2026-07-31 182555" src="https://github.com/user-attachments/assets/a0c936a6-2b57-4e6e-90f2-d40042975669" />
<img width="1532" height="688" alt="Screenshot 2026-07-31 182940" src="https://github.com/user-attachments/assets/bab7cc7a-7bf9-4939-a91a-6e9a8fb59ea9" />
<img width="1532" height="690" alt="Screenshot 2026-07-31 182845" src="https://github.com/user-attachments/assets/76bc36b5-3721-4179-9440-c9278547daf4" />
<img width="1536" height="692" alt="Screenshot 2026-07-31 183007" src="https://github.com/user-attachments/assets/07787e5a-2540-4621-aece-3243a0639e07" />
<img width="1535" height="687" alt="Screenshot 2026-07-31 183046" src="https://github.com/user-attachments/assets/f3c7ae63-cdba-49c0-a743-40eed1d9003a" />
<img width="1536" height="696" alt="Screenshot 2026-07-31 195754" src="https://github.com/user-attachments/assets/36b6acc1-ba34-4c8b-acd9-4213eda2bd99" />
<img width="1536" height="691" alt="Screenshot 2026-07-31 183249" src="https://github.com/user-attachments/assets/b296d265-593c-42a1-9409-6b9b6aee66ca" />
<img width="1536" height="692" alt="Screenshot 2026-07-31 183344" src="https://github.com/user-attachments/assets/61ba0a43-e043-46f3-bccb-f526ba3bf2e5" />

## ⚙️ Veri Mühendisliği ve Makine Öğrenmesi (Data Pipeline)

Uygulamanın arka planında, kullanıcı tavsiyelerini ve içerik benzerliklerini milisaniyeler içinde hesaplayabilmek için iki farklı veri işleme hattı (Pipeline) kurulmuştur:

### 1. İşbirlikçi Filtreleme (Collaborative Filtering) - Büyük Veri Mimarisi
Kullanıcıların geçmiş izleme alışkanlıkları ve ortak puanlama davranışları üzerinden kişiselleştirilmiş film önerilerinin oluşturulduğu aşamadır.

- **Teknolojiler:** Google Cloud Storage, Google Cloud Dataproc, Apache Spark (PySpark).
- **Süreç:** Devasa boyuttaki ham veriler Google Cloud Storage bucket'larına aktarılmış, ardından Dataproc üzerinde ayağa kaldırılan kümeler (cluster) aracılığıyla PySpark kullanılarak dağıtık veri işleme gerçekleştirilmiştir. Model eğitimi sonucunda her kullanıcı için en iyi 10 film tavsiyesi önceden hesaplanarak dışa aktarılmıştır.

### 2. İçerik Temelli Filtreleme (Content-Based) - NLP ve Vektörizasyon
Filmlerin sadece türlerine göre değil, doğrudan işledikleri konulara ve hikaye temalarına göre eşleştirilmesini sağlayan Doğal Dil İşleme (NLP) aşamasıdır.

- **Teknolojiler:** Kaggle (T4 GPU), TMDB API, Hugging Face Transformers (all-MiniLM-L6-v2), PyTorch, Asenkron Python (Asyncio).
- **Süreç:** TMDB API limitlerine takılmamak için özel bir "Batching & Sleep" algoritması yazılarak 56.819 filmin özeti eksiksiz olarak çekilmiştir. Kaggle GPU ortamında bu metinler, dil modeli aracılığıyla 384 boyutlu matematiksel vektörlere (embeddings) dönüştürülmüş ve Kosinüs Benzerliği (Cosine Similarity) hesaplamaları için optimize edilmiş bir matris olarak uygulamaya entegre edilmiştir.

## 🌟 Özellikler

- **3D Cold Start Deneyimi (Tinder Tarzı):** Kullanıcının film zevklerini analiz etmek için geliştirilen 3 boyutlu, tamamen akıcı ve "Spam Click" korumalı interaktif kart kaydırma deneyimi. 
- **Yapay Zeka Destekli Motor:** Kullanıcının beğendiği/geçtiği filmleri analiz ederek, devasa veritabanından en uygun filmleri "İşbirlikçi Filtreleme" ve "Kosinüs Vektör Benzerliği" algoritmalarıyla saniyeler içinde sunar.
- **Elmas Standartı Animasyonlar:** GSAP (GreenSock) destekli 3 boyutlu "Deste Dağıtımı (Fan-out & Collapse)" ve fütüristik "Holografik Yükleme" (Cinematic Loader) animasyonları.
- **Maksimum Performans:** Arayüzdeki 10 farklı yüksek çözünürlüklü film posterini arka planda eşzamanlı (Promise.all) çekerek bekleme süresini sıfıra indiren paralel mimari.

## 🚀 Kurulum

Projeyi kendi bilgisayarınızda çalıştırmak için aşağıdaki adımları izleyin:

1. **Depoyu klonlayın:**
   ```bash
   git clone https://github.com/KULLANICI_ADINIZ/cineflow.git
   cd cineflow
   ```

2. **Bağımlılıkları yükleyin:**
   Projeyi çalıştırmak için gerekli olan kütüphaneleri kurun.
   ```bash
   pip install -r requirements.txt
   ```

3. **Gizli API Ayarlarınızı yapın:**
   Projenin ana dizininde (main.py ile aynı yerde) bir `.env` dosyası oluşturun ve TMDB (The Movie Database) API anahtarınızı ekleyin. (*Bu dosya .gitignore sayesinde GitHub'a yüklenmez.*)
   ```env
   TMDB_API_KEY=sizin_tmdb_api_anahtariniz
   ```

4. **Sunucuyu başlatın:**
   FastAPI sunucusunu başlatın.
   ```bash
   uvicorn main:app --reload --port 8000
   ```

5. **Arayüze Erişin:**
   Tarayıcınızdan `http://localhost:8000` adresine giderek sinematik evreninizi keşfetmeye başlayın!

## 🛡️ Güvenlik ve Mimari
Bu proje, API anahtarlarını Frontend (JavaScript) tarafında açıkça göstermek yerine, Backend'den (Python) güvenli bir Proxy uç noktası üzerinden (`/api/config`) çekerek kurumsal düzeyde güvenlik standartlarına (Environment Variables) uyar. 

---
*Geliştiriciler tarafından 💙 ile tasarlanmış ve kodlanmıştır.*
