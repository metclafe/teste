import express, { Request, Response } from 'express';
import turnstile from './lib/ends/turnstile';
import iuam from './lib/ends/iuam';
import { connect } from "./lib/browser/br";

const app = express();
const port = process.env.PORT || 8742;
const authToken = process.env.authToken || null;

(global as any).browserLimit = Number(process.env.browserLimit) || 20;
// 3 min default so captcha has time to resolve; use env timeOut or request body timeOut to override
(global as any).timeOut = Number(process.env.timeOut) || 180000;

const CACHE_TTL = 30 * 60 * 1000;

interface CacheEntry {
    expireAt: number;
    value: any;
}

interface Cache {
    [key: string]: CacheEntry;
}

const memoryCache: Cache = {};

async function readCache(key: string): Promise<any> {
    const entry = memoryCache[key];
    if (entry && Date.now() < entry.expireAt) {
        return entry.value;
    }
    return null;
}

async function writeCache(key: string, value: any, ttl: number = CACHE_TTL) {
    memoryCache[key] = { expireAt: Date.now() + ttl, value };
}

// Limpa entradas expiradas a cada 5 min para não vazar memória
setInterval(() => {
    const now = Date.now();
    for (const key in memoryCache) {
        if (memoryCache[key].expireAt <= now) {
            delete memoryCache[key];
        }
    }
}, 5 * 60 * 1000);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let server = app.listen(port, async () => {
    console.log(`Server running on port ${port}`);
});
// Keep connection open longer than request timeout so response can be sent
try {
    server.timeout = (global as any).timeOut + 30000;
} catch { }

let browser: any = null;

async function initBrowser() {
    if (browser && browser.isConnected()) return browser;

    try {
        const { browser: connectedBrowser } = await connect({
            headless: false,
            turnstile: true,
            connectOption: {
                defaultViewport: { width: 640, height: 480 },
            },
            disableXvfb: false,
            args: [
                '--window-size=640,480',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-extensions',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--no-first-run',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-ipc-flooding-protection',
                '--disable-hang-monitor',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-domain-reliability',
                '--disable-client-side-phishing-detection',
                '--disable-component-extensions-with-background-pages',
                '--no-default-browser-check',
                '--autoplay-policy=no-user-gesture-required',
                '--js-flags=--max-old-space-size=128',
            ],
        });

        browser = connectedBrowser;

        browser.on('disconnected', () => {
            console.log('Browser disconnected');
            browser = null;
        });

        return browser;
    } catch (error) {
        console.error('Failed to initialize browser:', error);
        throw error;
    }
}

initBrowser().then(() => console.log("Browser initialized")).catch(err => console.error("Initial browser launch failed", err));


async function getPage() {
    if (!browser || !browser.isConnected()) {
        await initBrowser();
    }

    if (!browser) {
        throw new Error("Browser not available");
    }

    // Usa BrowserContext para isolamento mais leve que abrir page direto
    const context = await browser.createBrowserContext();
    const page = await context.newPage();

    await page.setViewport({ width: 640, height: 480 });

    // Desabilita cache do browser pra não acumular disco
    const cdp = await page.createCDPSession();
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.detach();

    await page.goto('about:blank');
    await page.setRequestInterception(true);
    page.on('request', async (req: any) => {
        try {
            const type = req.resourceType();
            if (["image", "stylesheet", "font", "media"].includes(type)) {
                await req.abort();
            } else {
                await req.continue();
            }
        } catch (_) { }
    });

    // Guarda referência ao context para cleanup
    (page as any)._browserContext = context;

    return page;
}

app.post('/cloudflare', async (req: Request, res: Response): Promise<any> => {
    const startTime = Date.now();
    const data = req.body;
    if (!data || typeof data.mode !== 'string') {
        return res.status(400).json({ message: 'Bad Request: missing or invalid mode' });
    }
    if (authToken && data.authToken !== authToken) {
        return res.status(401).json({ message: 'Unauthorized' });
    }

    if ((global as any).browserLimit <= 0) {
        return res.status(429).json({ message: 'Too Many Requests' });
    }

    let cacheKey: string = "", cached;
    if (data.mode === "iuam") {
        cacheKey = JSON.stringify(data);
        cached = await readCache(cacheKey);
        if (cached) {
            return res.status(200).json({ ...cached, cached: true, elapsed: ((Date.now() - startTime) / 1000).toFixed(2) + 's' });
        }
    }

    (global as any).browserLimit--;
    let result: any;
    let page;
    const reqT = Number(data.timeOut);
    const requestTimeout = reqT > 0 ? reqT : (global as any).timeOut;
    const prevTimeOut = (global as any).timeOut;
    (global as any).timeOut = requestTimeout;

    try {
        page = await getPage();

        switch (data.mode) {
            case "turnstile":
                result = await turnstile(data as any, page)
                    .then(token => ({ token }))
                    .catch(err => ({ code: 500, message: err.message }));
                break;

            case "iuam":
                result = await iuam(data as any, page)
                    .then(r => ({ ...r }))
                    .catch(err => ({ code: 500, message: err.message }));

                if (!result.code || result.code === 200) {
                    const ttl = Number(data.ttl || data.expire) || CACHE_TTL;
                    await writeCache(cacheKey, result, ttl);
                }
                break;

            default:
                result = { code: 400, message: 'Invalid mode' };
        }
    } catch (err: any) {
        result = { code: 500, message: err.message };
    } finally {
        (global as any).timeOut = prevTimeOut;
        if (page) {
            try {
                // Fecha o BrowserContext inteiro (libera todos os recursos da page)
                const ctx = (page as any)._browserContext;
                if (ctx) {
                    await ctx.close();
                } else {
                    await page.close();
                }
            } catch { }
        }
        (global as any).browserLimit++;
    }

    if (!result.elapsed) {
        result.elapsed = ((Date.now() - startTime) / 1000).toFixed(2) + 's';
    }
    res.status(result.code ?? 200).json(result);
});

app.use(async (req: Request, res: Response) => {
    res.status(404).json({ message: 'Not Found' });
});

export default app;
