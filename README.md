# CineFlow — Sinematik Evrenini Keşfet 🎬

CineFlow, modern bir 3 Boyutlu (3D) web arayüzüne ve yapay zeka tabanlı (Vektör Benzerliği) bir film öneri motoruna sahip, elit ve yepyeni bir film keşif platformudur. 

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
