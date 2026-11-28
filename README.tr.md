<p align="center">
  <img src="app/public/icons/logo.svg" width="96" height="96" alt="Calends logosu" />
</p>

<h1 align="center">Calends</h1>

<p align="center">
  Abonelik ödemelerini, ortak ödemeleri ve ön ödemeli bakiyeleri kendi sunucunuzda takip edin.
</p>

<p align="center">
  <a href="https://calends.date">Web Sitesi</a> ·
  <a href="https://demo.calends.date">Canlı Demo</a> ·
  <a href="#hızlı-başlangıç">Hızlı Başlangıç</a> ·
  <a href="#yapay-zeka-ve-mcp">Yapay Zeka ve MCP</a> ·
  <a href="README.md">English</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="docs/screenshots/overview.png" alt="Calends genel görünüm" width="49%" />
  <img src="docs/screenshots/timeline.png" alt="Faturalandırma dönemleri, plan değişiklikleri ve ödeme yöntemleriyle Calends abonelik zaman çizelgesi" width="49%" />
</p>
<p align="center"><sub>Genel görünüm ve abonelik zaman çizelgesi · Kurgusal demo verileri</sub></p>

---

## Faturalandırma ve ödeme geçmişi

Ne ödediğinizi, ne zaman yenileneceğini ve kimin size borçlu olduğunu takip edin. Calends; abonelikleri, ortak planları ve ön ödemeli bakiyeleri tek bir özel, tek sahipli defterde toplar; isteğe bağlı salt okunur herkese açık bir sayfa ve MCP üzerinden yapay zeka erişimi sunar.

- **Esnek faturalandırma** — aylık, yıllık, özel döngüler ve ömür boyu satın alımlar; faturalandırmadan bağımsız isteğe bağlı sözleşme süreleri ve yenileme bildirimleri, deneme süreleri, giriş fiyatları, bonus dönemler, duraklatmalar, faturalı ödemeler, ayrı fatura/ödeme takibi, peşin tahsilat ve iptal son tarihleri.
- **Kullanım sayaçları** — dönem bazlı kullanımı veya kümülatif okumaları herhangi bir birimde takip edin; abonelikler arası paylaşılan sayaçlar, kullanım metrikleri, hizalanmış grafikler ve ödeme kayıtlarında kullanım bilgisi.
- **Faturalandırma geçmişi** — fiyat, plan ve bölge değişikliklerini, boşlukları ve çakışan abonelikleri saklayın; yükseltmeler eski planın kullanılmayan kısmını kredi olarak düşebilir. Toplam harcamayı, gerçek aylık maliyeti ve her bir ödemeyi görün.
- **Devirler ve bölünmüş ödemeler** — ikinci el devralmaları ve yeniden satışları net maliyete dahil edin, bir ödemeyi birden fazla ödeme yöntemine bölün.
- **Çoklu para birimi** — geçmiş ödemeler için tarihsel döviz kurları, tahminler için güncel kurlar ve seçtiğiniz görüntüleme para birimi.
- **Bakiyeler ve ortak planlar** — ön ödemeli kredileri ve hediye kartlarını takip edin, bakiyelerin ne zaman tükeneceğini tahmin edin ve arkadaşlarınız için ödemeleri yönetin. Ortak planlarda tarihli tahsilat kuralları, üye geçersiz kılmaları, atlanan dönem tahsilatıyla dönem bazlı makbuzlar, ön ödemeler ve feragatler, gecikme takibi ve çıkış iadeleri bulunur; üye sayfası tıklamayla makbuz ayrıntılarını gösteren aylık dönem ızgarası, ön ödemeler ve feragatler sunar; kişiler ise özel avatarlara, özel renklere ve her plan için ayrı bir hesaba sahiptir.
- **Raporlar ve takvim** — harcama eğilimleri, isteğe bağlı 3B çubuklu günlük ısı haritası, nakit ve tahakkuk, fon akışları, bölge ve kategori profilleri, ön ödemeli değer, iptal tasarrufları, abonelik kontrolleri ve paylaşılabilir yıl özeti. Aylık/yıllık takvimler ve özel bir ICS akışı içerir.
- **Arama** — abonelik listesinde, komut paletinde ve seçicilerde Çince adları tam pinyin, baş harfler veya karma hecelerle bulun.
- **Yenileme hatırlatıcıları** — e-posta, Telegram, Lark/Feishu, DingTalk, WeCom, Slack, Discord, Bark, ntfy, ServerChan ve özel webhook'lar.
- **Yapay zeka erişimi** — izin kapsamı sınırlandırılmış token'lar ve yazma işlemleri için önizlemelerle, MCP uyumlu bir asistandan defterinizi sorgulayın ve güncelleyin.
- **Dosyalar** — faturaları, makbuzları ve sözleşmeleri aboneliklerle birlikte saklayın, ödemelere veya sözleşme sürelerine bağlayın, görselleri ve PDF'leri önizleyin ve dosya içerikleriyle tam yedek dışa aktarın.
- **Harici defterleri içe aktarma** — tarayıcınızda Wallos ve diğer hizmetlerden CSV dosyalarını, ZIP yedeklerini ve veritabanlarını önizleyin ve içe aktarın.
- **Herkese açık sayfa düzenleyicisi** — salt okunur herkese açık sayfanızın başlığını özelleştirin ve ızgara tuval üzerinde bileşenleri (widget) düzenleyin.
- **Otomatik şifreli yedeklemeler** — parola tabanlı şifreleme, dönen saklama süresi ve bir defteri geri yüklemeden veya değiştirmeden önce güvenlik yedeği ile S3 uyumlu depolamaya veya WebDAV'a yedekleyin.
- **Depolama ve erişim** — parola ve geçiş anahtarı (passkey) ile oturum açma, uzaktan cihaz oturumu kapatma, sunucu tarafı maskeleme ile isteğe bağlı herkese açık paylaşım, JSON yedekleme/geri yükleme ve CSV içe/dışa aktarma. Avustralya İngilizcesi bölgesel biçimlendirmesiyle birlikte 14 dilde kullanılabilir.

## Hızlı başlangıç

Önce göz atmak ister misiniz? [Canlı demoyu deneyin](https://demo.calends.date).

### Cloudflare

[Cloudflare'e dağıtın](https://deploy.workers.cloudflare.com/?url=https://github.com/imetn/calends), Worker'a uzun ve rastgele bir `SETUP_TOKEN` gizli anahtarı ekleyin, ardından URL'sini açıp belirteci girin ve parolanızı belirleyin. Kaynaktan dağıtmak için [Cloudflare kılavuzuna](docs/self-hosting.md#cloudflare-from-source) bakın.

### Docker

```bash
curl -fsSL https://raw.githubusercontent.com/imetn/calends/main/docker/compose.prebuilt.yml -o compose.yml
docker compose up -d
docker compose logs calends
```

`http://localhost:8787/` adresini açın, günlüklerden kurulum belirtecini (setup token) girin ve parolanızı belirleyin.

### Tek satırlık kurulum

Systemd kullanan Debian veya Ubuntu üzerinde:

```bash
curl -fsSL https://calends.date/install.sh | sudo bash
```

Calends `127.0.0.1:8787` adresinde başlar; kendi ters vekil sunucunuzu (reverse proxy) buraya yönlendirin. Yükseltmek için aynı komutu çalıştırın.

Yükseltmeler, HTTPS, yapılandırma ve diğer seçenekler için [kendi sunucunuzda barındırma kılavuzuna](docs/self-hosting.md) bakın.

## Yapay zeka ve MCP

“Haftaya ne yenileniyor?”, “Bu yıl ne kadar harcadım?” veya “Netflix bugünden itibaren $17.99 oldu.” diye sorun. Calends, Streamable HTTP kullanarak `/mcp` uç noktasında durumsuz (stateless) bir [MCP](https://modelcontextprotocol.io) üzerinden 41 araç sunar.

**Yapay zekâ erişimi** sayfasında (`/connect`) salt okunur veya okuma/yazma belirteci oluşturun, ardından istemcinizi bağlayın. Tarayıcıda `/mcp` açmak sizi bu sayfaya yönlendirir; MCP istemcileri `/mcp` uç noktasını kullanır:

**Claude Code**

```bash
claude mcp add --transport http calends https://your-domain/mcp --header "Authorization: Bearer <token>"
```

**Codex**

```bash
export CALENDS_TOKEN='<token>'
codex mcp add calends --url https://your-domain/mcp --bearer-token-env-var CALENDS_TOKEN
```

Codex'i başlatan ortamda `CALENDS_TOKEN` değişkenini hazır bulundurun. Araçlar; abonelikleri, harcamaları, eğilimleri, alacakları ve içgörüleri, ayrıca fiyat, plan, durum ve ödeme değişikliklerini kapsar. Her yazma aracı `dry_run` destekler; yapay zeka erişimi Ayarlar'dan kapatılabilir.

Yerleşik asistan DeepSeek, OpenAI, Anthropic, Gemini ve Ollama dahil sağlayıcı ön ayarlarını, ayrıca özel OpenAI ve Anthropic uyumlu uç noktaları destekler.

## Gizlilik

Calends günde bir kez [telemetry.calends.date](https://telemetry.calends.date) adresine anonim kullanım istatistikleri gönderir: rastgele bir kurulum kimliği, uygulama sürümü, nasıl çalıştığı (Cloudflare, Docker/Node veya yükleyici), arayüz dili ve günlük uygulama açılışı, sayfa görüntüleme, asistan mesajı ve MCP araç çağrısı sayıları. Abonelik adlarını, fiyatları, ödemeleri, notları, hesap ayrıntılarını veya yazdığınız hiçbir şeyi asla göndermez. Sayımlar kendi sunucunuz tarafından gönderilir; tarayıcı yalnızca sayfa görüntülemelerini sunucuya bildirir.

Bunu Ayarlar → Anonim kullanım istatistikleri altından kapatın veya dağıtırken `CALENDS_TELEMETRY=0` (ya da `DO_NOT_TRACK=1`) ayarlayın; bu ayar da seçeneği kilitli olarak kapalı tutar. Geliştirme derlemeleri asla veri göndermez.

## Katkıda bulunma

Hata bildirimleri, çeviriler ve pull request'ler memnuniyetle karşılanır. Yerel kurulum, kontroller ve katkıda bulunma yönergeleri için [CONTRIBUTING.md](CONTRIBUTING.md) dosyasına bakın.

Bir alt sistemi değiştirmeden önce [mimari](ARCHITECTURE.md) ve [kod standartları](docs/code-standards.md) belgeleriyle başlayın. Kodlama ajanları [AGENTS.md](AGENTS.md) dosyasını kullanır; `CLAUDE.md` aynı talimatları içe aktarır.

React 19, Vite, HeroUI / React Aria, shadcn/ui ve Cloudflare Workers + D1 (SQLite) ile oluşturulmuştur. Faturalandırma, döviz kurları ve diğer alan mantığı tarayıcı ve Worker arasında `shared/` içinde paylaşılır.

Çeviriler `shared/locales/<locale>/<namespace>.json` altında yer alır; kaynak diller İngilizce ve Basitleştirilmiş Çince'dir.

## Adı hakkında

_Calends_, her Roma ayının ilk günüydü; hesapların kapatıldığı ve borçların tahsil edildiği gündü. _Calendar_ (takvim) sözcüğü de buradan gelir.

## Lisans

Calends, MIT Lisansı altında açık kaynaklıdır; [LICENSE](LICENSE) dosyasına bakın. Yazılımın kopyalarında veya önemli bölümlerinde telif hakkı ve lisans bildirimlerini korumanız koşuluyla ticari amaçlar dahil kullanabilir, değiştirebilir ve yeniden dağıtabilirsiniz. Calends'i çatallarsanız (fork), kullanıcıların sürümünüzü bu projeden ayırt edebilmesi için lütfen farklı bir ad kullanın ve Calends'i yukarı akış (upstream) kaynağı olarak belirtin.

Latin harfleri ve rakamları, [MiSans lisansı](https://hyperos.mi.com/font/en/download/) kapsamında `app/public/fonts/` içinde değiştirilmeden paketlenen Xiaomi'nin [MiSans Latin](https://hyperos.mi.com/font/en/) yazı tipini kullanır; bu yazı tipi MIT Lisansı kapsamında değildir ve tek başına değiştirilemez veya yeniden dağıtılamaz.
