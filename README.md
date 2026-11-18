# CineFlow — Sinematik Evrenini Keşfet 🎬

![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?style=for-the-badge&logo=python&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white)
![NumPy](https://img.shields.io/badge/NumPy-384D_Vectors-013243?style=for-the-badge&logo=numpy&logoColor=white)
![GSAP](https://img.shields.io/badge/GSAP_3-3D_Motion-88CE02?style=for-the-badge&logo=greensock&logoColor=black)
![TMDB](https://img.shields.io/badge/TMDB_API-Integrated-01B4E4?style=for-the-badge&logo=themoviedatabase&logoColor=white)

**CineFlow**, modern bir **3 Boyutlu (3D) Glassmorphism** web arayüzüne ve **Yapay Zeka (NLP Vektör Benzerliği & İşbirlikçi Filtreleme)** tabanlı bir öneri motoruna sahip, yeni nesil bir film keşif platformudur. Kullanıcının sinematik zevklerini interaktif kart kaydırma (Swipe) deneyimiyle analiz eder ve **46.500+ film** arasından en yüksek kosinüs benzerliğine sahip yapımları saniyeler içinde sunar.

---

## 📸 Ekran Görüntüleri (Showcase)

<img width="1536" height="693" alt="Screenshot 2026-07-31 182555" src="https://github.com/user-attachments/assets/a0c936a6-2b57-4e6e-90f2-d40042975669" />
<img width="1532" height="688" alt="Screenshot 2026-07-31 182940" src="https://github.com/user-attachments/assets/bab7cc7a-7bf9-4939-a91a-6e9a8fb59ea9" />
<img width="1532" height="690" alt="Screenshot 2026-07-31 182845" src="https://github.com/user-attachments/assets/76bc36b5-3721-4179-9440-c9278547daf4" />
<img width="1536" height="692" alt="Screenshot 2026-07-31 183007" src="https://github.com/user-attachments/assets/07787e5a-2540-4621-aece-3243a0639e07" />
<img width="1535" height="687" alt="Screenshot 2026-07-31 183046" src="https://github.com/user-attachments/assets/f3c7ae63-cdba-49c0-a743-40eed1d9003a" />
<img width="1536" height="696" alt="Screenshot 2026-07-31 195754" src="https://github.com/user-attachments/assets/36b6acc1-ba34-4c8b-acd9-4213eda2bd99" />
<img width="1536" height="691" alt="Screenshot 2026-07-31 183249" src="https://github.com/user-attachments/assets/b296d265-593c-42a1-9409-6b9b6aee66ca" />
<img width="1536" height="692" alt="Screenshot 2026-07-31 183344" src="https://github.com/user-attachments/assets/61ba0a43-e043-46f3-bccb-f526ba3bf2e5" />

---

## 🌟 Öne Çıkan Özellikler

- **Sinematik Dönem Seçimi & 3D Portal Geçişi (Onboarding):** Kullanıcının *Klasikler (1970–1990)*, *Nostalji (1990–2010)*, *Modern Çağ (2010–2026)* veya *Tüm Yıllar* dönemlerinden birini seçerek GSAP destekli 3 boyutlu portal animasyonuyla deneyime başlaması.
- **Tür seçimi ve 3D kart destesi:** Dönemden sonra birden fazla tür seçilebilir. Kartlar yıl aralığına ve seçilen türlerden en az birine uyar. Fare, dokunma ve klavye yön tuşları desteklenir.
- **Kart arkası ve film detayları:** Film özeti ve TMDB puanı birlikte görünür. Sağ üstteki seçici 10 özet dili sunar, Türkçe varsayılandır.
- **Oturum önerileri:** Beğenilen ve geçilen filmler, konu vektörleri, ortak türler ve yerel başrol diziniyle birlikte değerlendirilir. “Yeni karışım” mevcut seçimlerle farklı uygun adaylar sunar.
- **Öneri nedenleri ve sıralama:** Kart detayında filmin neden önerildiği görünür. Liste kişisel sıraya veya TMDB puanına göre sıralanabilir.
- **Elmas Standartı Animasyonlar & Mobil Optimizasyon:** GSAP (GreenSock) destekli 3 boyutlu *"Deste Dağıtımı (Fan-out & Collapse)"*, mobil cihazlara özel *"Şelale (Drop-in)"* dizilimi, fütüristik *"Holografik Yükleme" (Cinematic Loader)* animasyonları ve düşük donanımlı mobil/iOS cihazlar için otomatik *Graceful Degradation* desteği.
- **Sıfır Bekleme Süreli Paralel Mimari:** Arayüzdeki yüksek çözünürlüklü film posterlerini ve özet çevirilerini arka planda eşzamanlı (`Promise.all` & akıllı batching) önbelleğe alarak FOUC (Flash of Unstyled Content) ve yükleme gecikmelerini ortadan kaldırır.

---

## 🧠 Sistem Nasıl Çalışır?

1. **Dönem ve tür seçimi:** Kullanıcı önce yıl aralığını, ardından istediği türleri seçer. Kartlar bu seçimlere göre hazırlanır.
2. **Tercih Analizi (Cold-Start):** Kullanıcı karşısına çıkan 10 filmlik desteyi sağa (*Beğendim*) veya sola (*Geç*) kaydırır. Kartın üzerine tıkladığında kart 3 boyutlu olarak döner ve Türkçe özeti gösterir.
3. **Aday bulma ve sıralama:** Mevcut vektörler konu benzerliğini sağlar. Tür ve başrol eşleşmeleri ayrı aday havuzlarından seçilir. Değerlendirilmiş filmler çıkarılır.
4. **Keşif listesi:** Yeterli uygun kayıt varsa 25 film sunulur. Kullanıcı öneri nedenlerini görebilir ve kartları tekrar seçmeden yeni bir karışım isteyebilir. [Öneri motoru ayrıntıları](docs/session-recommendations.md)

---

## 🛠️ Teknoloji Yığını

| Katman | Kullanılan Teknolojiler |
| :--- | :--- |
| **Backend & API** | Python 3.10+, FastAPI, Uvicorn, Pydantic, python-dotenv |
| **Veri Bilimi & AI** | NumPy (L2-Normalized Cosine Similarity Matrix), Pandas (Vectorized Filtering & Pickle/CSV I/O) |
| **Frontend & UI** | HTML5, Modern CSS3 (3D Perspective, Backdrop-Filter Glassmorphism), Vanilla JavaScript (ES6+) |
| **Animasyon & İkon** | GSAP 3 (GreenSock Animation Platform), Lucide Icons |
| **Harici Servisler** | TMDB (The Movie Database) REST API, isteğe bağlı Google Cloud Translation |

---

## 📂 Proje Dizin Yapısı

```text
FilmOneriSistemi/
├── main.py                  # FastAPI Backend, NLP Vektör Motoru, Çeviri Proxy & Güvenlik Katmanı
├── static/                  # Ön Yüz (Frontend) Statik Dosyaları
│   ├── index.html           # 3D Arayüz İskeleti (Onboarding, Cold Start, Hologram Modal)
│   ├── style.css            # Antigravity Tasarım Sistemi (Glassmorphism & CSS 3D Transforms)
│   └── app.js               # GSAP Animasyon Motoru, Swipe Fiziği, TMDB & API İstemcisi
├── data/                    # [Git-Ignored] Yerel Veri Setleri (100 MB+ Boyut Sınırı Nedeniyle)
│   ├── movies_with_embeddings.pkl
│   └── export_final_recommendations_top10_part-00000-*.csv
├── .env                     # [Git-Ignored] Gizli Ortam Değişkenleri (TMDB_API_KEY)
├── .gitignore               # Güvenlik ve Depo Temizliği Kuralları
└── README.md                # Proje Dokümantasyonu ve Kurulum Rehberi
```

---

## 🚀 Sıfırdan Kurulum ve Çalıştırma Rehberi

Projeyi GitHub üzerinden ilk kez indirip kendi bilgisayarında çalıştırmak isteyen geliştiriciler için adım adım kurulum talimatları:

### Ön Gereksinimler
- **Python 3.10 veya üzeri** ([python.org](https://www.python.org/downloads/))
- **Git** ([git-scm.com](https://git-scm.com/))
- **TMDB API Anahtarı (Ücretsiz):** Film posterlerinin ve TMDB puanlarının çekilebilmesi için [themoviedb.org](https://www.themoviedb.org/settings/api) adresinden ücretsiz bir API anahtarı alabilirsiniz.

---

### 1. Depoyu Bilgisayarınıza Klonlayın
Terminal veya PowerShell ekranını açarak projeyi indirin ve proje klasörüne girin:

```bash
git clone https://github.com/enesgocek/FilmOneriSistemi.git
cd FilmOneriSistemi
```

---

### 2. Sanal Ortam (Virtual Environment) Oluşturun ve Kütüphaneleri Kurun
Sisteminizdeki global Python paketleriyle çakışma yaşanmaması için proje dizininde izole bir sanal ortam (`.venv`) oluşturup gerekli kütüphaneleri doğrudan kurun:

#### **Windows (PowerShell):**
```powershell
# 1. Sanal ortamı oluşturun
python -m venv .venv

# 2. Sanal ortamı aktif edin
.\.venv\Scripts\Activate.ps1

# 3. Gerekli Python kütüphanelerini yükleyin
pip install fastapi uvicorn pandas numpy pydantic python-dotenv requests
```
> **Not (Windows ExecutionPolicy):** Eğer `Activate.ps1` çalıştırırken yetki hatası alırsanız, sanal ortamı aktif etmeden doğrudan şu komutla da paketleri kurabilirsiniz:
> `.\.venv\Scripts\pip.exe install fastapi uvicorn pandas numpy pydantic python-dotenv requests`

#### **macOS / Linux (Bash / Zsh):**
```bash
# 1. Sanal ortamı oluşturun ve aktif edin
python3 -m venv .venv
source .venv/bin/activate

# 2. Gerekli Python kütüphanelerini yükleyin
pip install fastapi uvicorn pandas numpy pydantic python-dotenv requests
```

---

### 3. Veri Seti Dosyalarını (`data/`) Yerleştirin
GitHub'ın 100 MB dosya boyutu sınırı nedeniyle büyük boyutlu yapay zeka matris dosyaları `.gitignore` ile hariç tutulmuştur. Proje ana dizininde `data/` adında bir klasör oluşturun ve aşağıdaki veri dosyalarını bu klasörün içine yerleştirin:

- **`data/movies_with_embeddings.pkl`** *(Zorunlu — 46.528 filmin metaverileri ve 384 boyutlu NLP vektör gömmeleri)*
- **`data/export_final_recommendations_top10_part-00000-d07c0c1a-98a2-472f-aa5f-7d03909d98ba-c000.csv`** *(İsteğe bağlı demo verisi. `CINEFLOW_DEMO_TOKEN` tanımlandığında yüklenir.)*

---

### 4. Gizli API Anahtarınızı (`.env`) Tanımlayın
Projenin ana dizininde (`main.py` ile aynı dizinde) `.env` adında bir dosya oluşturun ve içerisine kendi TMDB API anahtarınızı ekleyin (*Bu dosya güvenlik amacıyla `.gitignore` tarafından korunmaktadır ve GitHub'a yüklenmez*):

```env
TMDB_API_KEY=sizin_tmdb_api_anahtariniz_buraya
```

**PowerShell ile tek satırda oluşturmak isterseniz:**
```powershell
Set-Content -Path ".env" -Value "TMDB_API_KEY=sizin_tmdb_api_anahtariniz_buraya"
```

Film özetleri yerel arşivden film kimliğiyle alınır ve sunucuda yerel modellerle çevrilir. Özet ve çeviri, yer tutucular ve belirgin izleyici yorumu kalıpları için kontrol edilir. Yeni bir ortamda çeviri paketlerini ve modelleri bir kez kurun:

```powershell
.\.venv\Scripts\python.exe -m pip install "ctranslate2>=4.6,<5" "sentencepiece>=0.2,<1" "langdetect==1.0.9"
.\.venv\Scripts\python.exe scripts/setup_translation_models.py
```

Dokuz model toplam yaklaşık 1 GB yer kaplar ve Git dışında tutulan `data/translation/` dizinine kurulur. Yalnızca Türkçe modeli kurmak için ikinci komuta `tr` ekleyin. Yerel modelin çeviremediği kaynak diller için isteğe bağlı olarak `.env` içinde `GOOGLE_TRANSLATE_API_KEY` tanımlanabilir.

Türkçe için Windstorm Labs tarafından [HPLT tabanlı modelin CTranslate2 sürümü](https://huggingface.co/WindyTranslate/translate-windy-hplt-en-tr) kullanılır ([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)). Diğer hedef dillerin modelleri [Argos Translate](https://github.com/argosopentech/argospm-index) arşivinden gelir.

---

### 5. Sunucuyu Başlatın
Kurulum tamamlandıktan sonra FastAPI sunucusunu Uvicorn ile başlatın:

**Sanal ortam aktifken:**
```bash
uvicorn main:app --reload --port 8000
```

**Veya doğrudan sanal ortam ikilisiyle (Windows):**
```powershell
.\.venv\Scripts\uvicorn.exe main:app --reload --port 8000
```

Terminalde aşağıdaki çıktıyı gördüğünüzde veri setleri belleğe yüklenmiş ve sunucu hazır demektir:
```text
[INFO] Starting data loading into memory...
[OK] Loaded 46528 movie embeddings matrix ((46528, 384))
[OK] Loaded collaborative filtering picks for 162541 users
[OK] Data initialization complete!
INFO: Uvicorn running on http://127.0.0.1:8000 (Press CTRL+C to quit)
```

---

### 6. Uygulamayı Tarayıcıda Açın
- **🎬 CineFlow 3D Web Arayüzü:** [http://localhost:8000](http://localhost:8000)
- **📘 Swagger UI (İnteraktif API Dokümantasyonu):** [http://localhost:8000/docs](http://localhost:8000/docs)
- **🩺 Sistem Sağlık Kontrolü:** [http://localhost:8000/health](http://localhost:8000/health)

---

## 📡 API Uç Noktaları (Endpoints)

| Metot | Uç Nokta | Açıklama |
| :---: | :--- | :--- |
| `GET` | `/` | Ana 3D CineFlow web arayüzünü sunar (`static/index.html`). |
| `GET` | `/cold-start` | Yıl aralığı ve birden fazla `genres` parametresiyle başlangıç kartlarını getirir. |
| `POST` | `/session-recommendations` | Film kimlikleri, yıl ve tür seçimleriyle en fazla 25 film ve öneri nedenlerini döndürür. |
| `GET` | `/similar` | Seçilen filme (`movie_title`) en yüksek kosinüs benzerliğine sahip içerik tabanlı önerileri hesaplar. |
| `GET` | `/recommendations/{user_id}` | Yetkili demo istemcisine bir örnek kullanıcının işbirlikçi filtreleme sonuçlarını döndürür. |
| `GET` | `/search` | Film adına göre hızlı alt dize (substring) araması ve otomatik tamamlama yapar. |
| `GET` | `/movies` | Veritabanındaki tüm filmleri sayfalanmış (`page`, `limit`) olarak listeler. |
| `GET` | `/sample-users` | Yetkili demo istemcisine örnek kullanıcı ID'lerini ve toplam kayıt sayısını döndürür. |
| `GET` | `/movies/{movie_id}/synopsis` | Yerel film özetini `language` dilinde döndürür. Varsayılan dil `tr` olur. |
| `GET` | `/api/movie-posters` | Yerel `movie_id` için TMDB poster yolunu ve puanını döndürür. |
| `GET` | `/health` | Sunucu durumunu, bellekteki toplam film ve kullanıcı sayısını döndürür. |

---

## 🛡️ Güvenlik ve Mimari Standartları

- TMDB ve isteğe bağlı Google Cloud anahtarları sunucuda kalır. Poster bilgisi yerel film kimliğiyle alınır. Google Cloud etkinleştirildiğinde yerel çevirisi bulunamayan film özetleri çevrilmek üzere bu servise gönderilir.
- Demo uçları varsayılan olarak kapalıdır. Etkinleştirmek için sunucuda rastgele bir `CINEFLOW_DEMO_TOKEN` belirleyin ve demo isteklerinde `Authorization: Bearer <token>` başlığı kullanın. Uzak bağlantıda HTTPS kullanın.
- IP başına dakikada 100 API isteği ve ayrı olarak 240 poster isteği sınırı uygulanır. Süresi dolan kayıtlar bellekten temizlenir.
- Tarayıcıya güvenlik başlıkları gönderilir. CDN betikleri sabit sürüm ve içerik bütünlüğü doğrulamasıyla yüklenir. Film özetleri arayüze düz metin olarak eklenir.

---

*Geliştiriciler tarafından 💙 ile tasarlanmış ve kodlanmıştır.*
