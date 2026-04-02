const express = require("express");
const { chromium } = require("playwright");

const app = express();
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;

// ============================================================
//  HEALTHCHECK
// ============================================================
app.get("/", (req, res) => {
  console.log("[ROOT] Healthcheck chamado");
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
//  ROTA EPROC TJSP - CONSULTA UNIFICADA
// ============================================================
app.post("/eproc", async (req, res) => {
  const numeroCNJ = limparNumero(req.body?.numeroCNJ);
  console.log("[EPROC] Requisição recebida. numeroCNJ =", numeroCNJ);

  if (!numeroCNJ || numeroCNJ.length !== 20) {
    console.log("[EPROC] numeroCNJ inválido");
    return res.status(400).json({
      ok: false,
      erro: "numeroCNJ inválido"
    });
  }

  let browser;

  try {
    console.log("[EPROC] Abrindo Chromium...");
    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled"
      ]
    });

    console.log("[EPROC] Criando contexto...");
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "pt-BR"
    });

    const page = await context.newPage();

    console.log("[EPROC] Indo para a consulta unificada...");
    await page.goto(
      "https://eproc-consulta.tjsp.jus.br/consulta_1g/externo_controlador.php?acao=tjsp@consulta_unificada_publica/consultar",
      {
        waitUntil: "domcontentloaded",
        timeout: 120000
      }
    );

    console.log("[EPROC] URL atual após goto:", page.url());
    console.log("[EPROC] Título após goto:", await page.title());

    await page.waitForTimeout(5000);

    const temCaptcha = await page.locator(".cf-turnstile").count();
    console.log("[EPROC] Captcha detectado?", temCaptcha > 0);

    if (temCaptcha > 0) {
      console.log("[EPROC] Aguardando validação automática do Turnstile...");

      try {
        await page.waitForFunction(() => {
          const hidden = document.querySelector("#hdnInfraCaptcha");
          return hidden && hidden.value === "1";
        }, { timeout: 45000 });

        console.log("[EPROC] Turnstile validado via hdnInfraCaptcha=1.");
      } catch (e) {
        console.log("[EPROC] hdnInfraCaptcha não ficou = 1 dentro do prazo.");
      }

      await page.waitForTimeout(3000);
    }

    const captchaHiddenValueAntes = await page.locator("#hdnInfraCaptcha").count()
      ? await page.locator("#hdnInfraCaptcha").inputValue()
      : null;

    console.log("[EPROC] Valor de #hdnInfraCaptcha antes da consulta:", captchaHiddenValueAntes);

    console.log("[EPROC] Procurando campo #txtNumProcesso...");
    await page.waitForSelector("#txtNumProcesso", {
      timeout: 60000
    });

    console.log("[EPROC] Campo encontrado. Preenchendo número...");
    await page.fill("#txtNumProcesso", numeroCNJ);

    console.log("[EPROC] Procurando botão #sbmNovo...");
    await page.waitForSelector("#sbmNovo", {
      timeout: 60000
    });

    console.log("[EPROC] Clicando em consultar...");
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 120000 }),
      page.click("#sbmNovo")
    ]);

    console.log("[EPROC] Clique executado. Aguardando 8000 ms...");
    await page.waitForTimeout(8000);

    const htmlAtual = await page.content();
    console.log("[EPROC] HTML atual length:", htmlAtual.length);
    console.log("[EPROC] URL após consulta:", page.url());
    console.log("[EPROC] Título após consulta:", await page.title());

    const captchaHiddenValueDepois = await page.locator("#hdnInfraCaptcha").count()
      ? await page.locator("#hdnInfraCaptcha").inputValue()
      : null;

    console.log("[EPROC] Valor de #hdnInfraCaptcha após consulta:", captchaHiddenValueDepois);

    if (
      htmlAtual.includes("Consulta Processual") &&
      htmlAtual.includes("cf-turnstile") &&
      captchaHiddenValueDepois !== "1"
    ) {
      console.log("[EPROC] Captcha ainda não validado de fato.");
      return res.status(403).json({
        ok: false,
        erro: "captcha_turnstile_bloqueando_fluxo"
      });
    }

    const linksProcesso = await page.locator('a[href*="exibir_processo"]').count();
    console.log("[EPROC] Links de processo encontrados:", linksProcesso);

    if (linksProcesso > 0) {
      console.log("[EPROC] Clicando no primeiro link do processo...");
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 120000 }),
        page.locator('a[href*="exibir_processo"]').first().click()
      ]);

      await page.waitForTimeout(5000);
      console.log("[EPROC] Processo aberto.");
      console.log("[EPROC] URL final:", page.url());
      console.log("[EPROC] Título final:", await page.title());
    }

    const htmlFinal = await page.content();
    console.log("[EPROC] HTML final capturado. Length =", htmlFinal.length);

    return res.json({
      ok: true,
      titulo: await page.title(),
      urlFinal: page.url(),
      htmlLength: htmlFinal.length,
      html: htmlFinal
    });

  } catch (e) {
    console.error("[EPROC] ERRO:", e);

    return res.status(500).json({
      ok: false,
      erro: e.message || "erro_desconhecido"
    });
  } finally {
    if (browser) {
      console.log("[EPROC] Fechando browser...");
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
