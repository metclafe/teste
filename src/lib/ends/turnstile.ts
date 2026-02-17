const fs = require('fs');
const path = require('path');

interface TurnstileData {
    domain: string;
    siteKey: string;
    userAgent?: string;
    proxy?: {
        username?: string;
        password?: string;
    };
}

const MIN_TOKEN_LEN = 30;

async function turnstile({ domain, proxy, siteKey, userAgent }: TurnstileData, page: any) {
    if (!domain) throw new Error("Missing domain parameter");
    if (!siteKey) throw new Error("Missing siteKey parameter");

    const timeout = (global as any).timeOut || 180000;

    // Seta o user-agent do cliente pra o token ser gerado com o mesmo fingerprint
    if (userAgent) {
        await page.setUserAgent(userAgent);
    }

    if (proxy?.username && proxy?.password) {
        await page.authenticate({
            username: proxy.username,
            password: proxy.password,
        });
    }

    const htmlContent = `
        <div class="turnstile"></div>
        <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onloadTurnstileCallback" defer></script>
        <script>
          window.onloadTurnstileCallback = function () {
            turnstile.render('.turnstile', {
              sitekey: '${siteKey}',
              callback: function (token) {
                var c = document.createElement('input');
                c.type = 'hidden';
                c.name = 'cf-response';
                c.value = token;
                document.body.appendChild(c);
              },
            });
          };
        </script>
    `;

    await page.setRequestInterception(true);
    page.removeAllListeners("request");
    page.on("request", async (request: any) => {
        try {
            const reqUrl = request.url();
            if ([domain, domain + "/"].includes(reqUrl) && request.resourceType() === "document") {
                await request.respond({
                    status: 200,
                    contentType: "text/html",
                    body: htmlContent,
                });
            } else if (reqUrl.includes("challenges.cloudflare.com/reports/v0/post")) {
                await request.abort();
            } else if (reqUrl.includes("challenges.cloudflare.com/turnstile/v0/b/88d68f5d5ea3/api.js")) {
                const localPath = path.join(__dirname, '../js/api.js');
                try {
                    const body = fs.readFileSync(localPath);
                    await request.respond({
                        status: 200,
                        contentType: 'application/javascript',
                        body: body
                    });
                } catch (e) {
                    console.error("Failed to serve local api.js:", e);
                    await request.continue();
                }
            } else if (
                reqUrl.includes("challenges.cloudflare.com") ||
                reqUrl.includes("/cdn-cgi/challenge-platform/")
            ) {
                await request.continue();
            } else {
                await request.abort();
            }
        } catch (_) { }
    });

    await page.goto(domain, { waitUntil: "domcontentloaded" });

    // Usa exposeFunction pra capturar o token instantaneamente via callback
    // ao invés de polling que pode perder o momento exato
    const token = await Promise.race([
        waitForTokenViaCallback(page, timeout),
        waitForTokenViaPolling(page, timeout),
    ]);

    if (!token || token.length < MIN_TOKEN_LEN) {
        throw new Error("Failed to get valid turnstile token");
    }

    return token;
}

/**
 * Aguarda o token aparecer no DOM via polling.
 * Fallback caso o callback não funcione.
 */
async function waitForTokenViaPolling(page: any, timeout: number): Promise<string | null> {
    try {
        await page.waitForSelector('[name="cf-response"]', { timeout });
        const token = await page.evaluate(() => {
            const el = document.querySelector('[name="cf-response"]');
            return el ? el.getAttribute('value') : null;
        });
        return token;
    } catch {
        return null;
    }
}

/**
 * Aguarda o token via waitForFunction — resolve assim que o valor
 * aparece no DOM, sem delay de polling.
 */
async function waitForTokenViaCallback(page: any, timeout: number): Promise<string | null> {
    try {
        await page.waitForFunction(
            () => {
                const el = document.querySelector('[name="cf-response"]');
                if (!el) return false;
                const val = el.getAttribute('value');
                return val && val.length > 30;
            },
            { timeout, polling: 200 }
        );
        const token = await page.evaluate(() => {
            const el = document.querySelector('[name="cf-response"]');
            return el ? el.getAttribute('value') : null;
        });
        return token;
    } catch {
        return null;
    }
}

export = turnstile;
