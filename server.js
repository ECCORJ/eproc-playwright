const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// ============================================================
//  HEALTHCHECK
// ============================================================
app.get("/", (req, res) => {
  res.json({
    ok: true,
    service: "eproc-playwright",
    status: "online"
  });
});

// ============================================================
//  UTIL
// ============================================================
function limparNumero(numero) {
  return String(numero || "").replace(/\D/g, "");
}

// ============================================================
//  ROTA EPROC TJSP
// ============================================================
app.post("/eproc", async (req, res) => {
  const numeroCNJ = limparNumero(req.body?.numeroCNJ);

  if (!numeroCNJ || numeroCNJ.length !== 20) {
    return res.status(400).json({
      ok: false,
      erro: "numeroCNJ inválido"
    });
  }

  let browser;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled"
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "pt-BR"
    });

    const page = await context.newPage();

    // ------------------------------------------------------------
    // 1. Abre a consulta pública
    // ------------------------------------------------------------
    await page.goto(
      "https://eproc-consulta.tjsp.jus.br/consulta_1g/externo_controlador.php?acao=tjsp@consulta_publica_eproc/consultar&tipoConsulta=NU&hash=fff89e2fd8cbe929a7254ff36844a36a",
      {
        waitUntil: "domcontentloaded",
        timeout: 120000
      }
    );

    // ------------------------------------------------------------
    // 2. Aguarda a tela carregar
    // ------------------------------------------------------------
    await page.waitForTimeout(5000);

    // ------------------------------------------------------------
    // 3. Se houver Turnstile, dá tempo para resolver/validar
    // ------------------------------------------------------------
    const temCaptcha = await page.locator(".cf-turnstile").count();

    if (temCaptcha > 0) {
      console.log("Captcha detectado. Aguardando resolução automática...");
      await page.waitForTimeout(15000);
    }

    // ------------------------------------------------------------
    // 4. Preenche o número do processo
    // ------------------------------------------------------------
    await page.waitForSelector('input[name="numNrProcesso"]', {
      timeout: 60000
    });

    await page.fill('input[name="numNrProcesso"]', numeroCNJ);

    // ------------------------------------------------------------
    // 5. Clica em consultar
    // ------------------------------------------------------------
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 120000 }),
      page.click('button[name="sbmConsultar"]')
    ]);

    await page.waitForTimeout(8000);

    // ------------------------------------------------------------
    // 6. Detecta se abriu lista ou já foi direto ao processo
    // ------------------------------------------------------------
    const htmlAtual = await page.content();

    // Se ainda estiver na tela de busca, provavelmente captcha bloqueou
    if (
      htmlAtual.includes("Consulta Processual - Busca de Processo") &&
      htmlAtual.includes("cf-turnstile")
    ) {
      return res.status(403).json({
        ok: false,
        erro: "captcha_turnstile_bloqueando_fluxo"
      });
    }

    // Se cair em página de resultados/lista, tenta clicar no primeiro processo
    const linksProcesso = await page.locator('a[href*="exibir_processo"]').count();

    if (linksProcesso > 0) {
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 120000 }),
        page.locator('a[href*="exibir_processo"]').first().click()
      ]);

      await page.waitForTimeout(5000);
    }

    // ------------------------------------------------------------
    // 7. Captura o HTML final
    // ------------------------------------------------------------
    const htmlFinal = await page.content();

    const titulo = await page.title().catch(() => "");

    return res.json({
      ok: true,
      titulo,
      htmlLength: htmlFinal.length,
      html: htmlFinal
    });

  } catch (e) {
    console.error("Erro /eproc:", e);

    return res.status(500).json({
      ok: false,
      erro: e.message || "erro_desconhecido"
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
});

// ============================================================
//  START
// ============================================================
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
