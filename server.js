const express = require('express');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const zlib = require('zlib');

chromium.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: '50mb' }));
const API_KEY = process.env.API_KEY;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', versao: '7.1.0', timestamp: new Date().toISOString() });
});

function autenticar(req, res, next) {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ erro: 'Chave inválida' });
  next();
}

// ── NF-e: Distribuição DFe (NF-e recebidas via SEFAZ) ────────────────────────
app.post('/nfe/distribuicao-dfe', autenticar, async (req, res) => {
  const { pfxBase64, pfxSenha, cnpj, ultimoNsu, ambiente } = req.body;
  if (!pfxBase64 || !pfxSenha || !cnpj) {
    return res.status(400).json({ ok: false, erro: 'pfxBase64, pfxSenha e cnpj obrigatórios' });
  }

  const tpAmb   = ambiente === 'producao' ? '1' : '2';
  const cUF     = '33'; // RJ
  const ultNsu  = String(ultimoNsu || 0).padStart(15, '0');
  const pfxBuf  = Buffer.from(pfxBase64, 'base64');
  const cnpjLimpo = String(cnpj).replace(/\D/g, '');

  const soapXml = `<?xml version="1.0" encoding="utf-8"?><soap12:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soap12="http://www.w3.org/2003/05/soap-envelope"><soap12:Body><nfeDistDFeInteresse xmlns="http://www.portalfiscal.inf.br/nfe/wsdl/NFeDistribuicaoDFe"><nfeDadosMsg><distDFeInt xmlns="http://www.portalfiscal.inf.br/nfe" versao="1.01"><tpAmb>${tpAmb}</tpAmb><cUFAutor>${cUF}</cUFAutor><CNPJ>${cnpjLimpo}</CNPJ><distNSU><ultNSU>${ultNsu}</ultNSU></distNSU></distDFeInt></nfeDadosMsg></nfeDistDFeInteresse></soap12:Body></soap12:Envelope>`;

  const host = tpAmb === '1'
    ? 'www1.nfe.fazenda.gov.br'
    : 'hom1.nfe.fazenda.gov.br';
  const path = '/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx';

  console.log(`[nfe-dfe] ${cnpjLimpo} | NSU=${ultimoNsu} | host=${host}`);

  try {
    const xmlResp = await new Promise((resolve, reject) => {
      const bodyBuf = Buffer.from(soapXml, 'utf-8');
      const req2 = https.request({
        host, path, method: 'POST', port: 443,
        pfx: pfxBuf, passphrase: pfxSenha,
        headers: {
          'Content-Type': 'application/soap+xml; charset=utf-8',
          'Content-Length': bodyBuf.length,
        },
        rejectUnauthorized: false,
      }, (resp) => {
        const chunks = [];
        resp.on('data', c => chunks.push(c));
        resp.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      });
      req2.on('error', reject);
      req2.write(bodyBuf);
      req2.end();
    });

    console.log(`[nfe-dfe] resposta ${xmlResp.length} bytes | preview: ${xmlResp.slice(0, 200)}`);
    return res.json({ ok: true, xmlResposta: xmlResp });

  } catch (e) {
    console.error('[nfe-dfe] erro:', e.message);
    return res.status(500).json({ ok: false, erro: e.message });
  }
});

// ── e-CAC ────────────────────────────────────────────────────────────────────
app.post('/ecac/consultar', autenticar, async (req, res) => {
  const { pfxBase64, pfxSenha, cnpj } = req.body;
  if (!pfxBase64 || !pfxSenha) return res.status(400).json({ sucesso: false, erro: 'pfxBase64 e pfxSenha obrigatórios' });
  const pfxPath = '/tmp/cert_' + crypto.randomUUID() + '.pfx';
  console.log('[' + new Date().toISOString() + '] v7.1 Consulta CNPJ ' + (cnpj || ''));
  try {
    fs.writeFileSync(pfxPath, Buffer.from(pfxBase64, 'base64'));
    const resultado = await consultarECAC(pfxPath, pfxSenha);
    res.json({ sucesso: true, dados: resultado, consultadoEm: new Date().toISOString() });
  } catch (e) {
    console.error('[ERRO]', e.message);
    res.status(500).json({ sucesso: false, erro: e.message });
  } finally {
    try { fs.unlinkSync(pfxPath); } catch {}
  }
});

async function consultarECAC(pfxPath, senha) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      clientCertificates: [
        { origin: 'https://acesso.gov.br', pfxPath, passphrase: senha },
        { origin: 'https://sso.acesso.gov.br', pfxPath, passphrase: senha },
        { origin: 'https://cav.receita.fazenda.gov.br', pfxPath, passphrase: senha },
      ],
      viewport: { width: 1366, height: 768 },
      locale: 'pt-BR',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    let oauthUrl = null;
    context.on('request', req => {
      const url = req.url();
      if (url.includes('sso.acesso.gov.br') || (url.includes('acesso.gov.br') && (url.includes('authorize') || url.includes('oauth') || url.includes('login')))) {
        if (!oauthUrl) oauthUrl = url;
      }
    });

    const page = await context.newPage();
    await page.goto('https://www.gov.br/receitafederal/pt-br/canais_atendimento/atendimento-virtual/acesso-govbr', { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);

    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => ({ txt: a.textContent?.trim().substring(0, 60), href: a.href })).filter(l => l.txt)
    );

    const certLinks = links.filter(l =>
      l.href.includes('sso.acesso.gov.br') || l.href.includes('acesso.gov.br/authorize') ||
      (l.href.includes('acesso.gov.br') && !l.href.includes('www.gov.br')) ||
      l.txt.toLowerCase().includes('certificado digital')
    );

    if (certLinks.length > 0) {
      await page.goto(certLinks[0].href, { waitUntil: 'load', timeout: 30000 });
    } else {
      try { await page.locator('text=Certificado Digital').first().click(); await page.waitForTimeout(3000); } catch {}
    }

    if (!oauthUrl && page.url().includes('acesso.gov.br')) oauthUrl = page.url();

    if (!oauthUrl) {
      await page.goto('https://cav.receita.fazenda.gov.br/autenticacao/login', { waitUntil: 'load', timeout: 45000 });
      await page.waitForTimeout(12000);
      for (const sel of ['button', '[role="button"]']) {
        try {
          const btns = await page.locator(sel).all();
          for (const btn of btns) {
            const txt = (await btn.textContent() || '').toLowerCase();
            if (txt.includes('entrar') || txt.includes('gov') || txt.includes('login')) { await btn.click(); await page.waitForTimeout(3000); break; }
          }
        } catch {}
      }
    }

    if (!oauthUrl) {
      const nonce = crypto.randomBytes(16).toString('hex');
      const state = crypto.randomBytes(16).toString('hex');
      oauthUrl = 'https://sso.acesso.gov.br/authorize?response_type=code&client_id=cav.receita.fazenda.gov.br&scope=openid+profile+email+govbr_confiabilidades&redirect_uri=https%3A%2F%2Fcav.receita.fazenda.gov.br%2Fautenticacao%2Fcallback%2Fgovbr&nonce=' + nonce + '&state=' + state;
    }

    await page.goto(oauthUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);

    if (page.url().includes('acesso.gov.br')) {
      await page.waitForTimeout(5000);
      for (const sel of ['text=Certificado Digital', 'button:has-text("Certificado")', 'a:has-text("Certificado")']) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 })) { await el.click(); break; }
        } catch {}
      }
      try { await page.waitForURL(/cav\.receita\.fazenda\.gov\.br(?!.*login)/, { timeout: 90000 }); } catch {}
    }

    const urlFinal = page.url();
    const autenticado = urlFinal.includes('cav.receita.fazenda.gov.br') && !urlFinal.includes('login') && !urlFinal.includes('Error');
    return await extrairDados(context, autenticado);
  } finally {
    await browser.close();
  }
}

async function extrairDados(context, autenticado) {
  const dados = {};
  if (autenticado) {
    const paginas = [
      { nome: 'situacaoFiscal', url: 'https://cav.receita.fazenda.gov.br/eCAC/servicos/situacaofiscal' },
      { nome: 'debitos', url: 'https://cav.receita.fazenda.gov.br/eCAC/servicos/dividas' },
      { nome: 'caixaPostal', url: 'https://cav.receita.fazenda.gov.br/eCAC/servicos/caixapostal' },
      { nome: 'declaracoes', url: 'https://cav.receita.fazenda.gov.br/eCAC/servicos/declaracoes' },
    ];
    for (const { nome, url } of paginas) dados[nome] = await extrairPagina(context, url, nome);
  } else {
    dados.statusAuth = { sucesso: false, conteudo: 'Autenticação pendente.' };
  }
  return dados;
}

async function extrairPagina(context, url, nome) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2000);
    const titulo = await page.title();
    const conteudo = ((await page.locator('body').textContent()) || '').trim();
    return { sucesso: true, titulo, urlFinal: page.url(), conteudo: conteudo.substring(0, 5000) };
  } catch (e) {
    return { sucesso: false, erro: e.message };
  } finally {
    await page.close();
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Orbi e-CAC Scraper v7.1 (stealth) porta ' + PORT));
