const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));
const API_KEY = process.env.API_KEY;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', versao: '5.0.0', timestamp: new Date().toISOString() });
});

function autenticar(req, res, next) {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ erro: 'Chave inválida' });
  next();
}

app.post('/ecac/consultar', autenticar, async (req, res) => {
  const { pfxBase64, pfxSenha, cnpj } = req.body;
  if (!pfxBase64 || !pfxSenha) return res.status(400).json({ sucesso: false, erro: 'pfxBase64 e pfxSenha obrigatórios' });
  const pfxPath = '/tmp/cert_' + crypto.randomUUID() + '.pfx';
  console.log('[' + new Date().toISOString() + '] v5 Consulta CNPJ ' + (cnpj || ''));
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
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    });

    // Intercepta TODAS as requisições para capturar URL do OAuth
    let oauthUrl = null;
    context.on('request', req => {
      const url = req.url();
      if (url.includes('acesso.gov.br') || url.includes('sso.acesso')) {
        console.log('REQUEST capturada:', url.substring(0, 200));
        if (!oauthUrl && (url.includes('authorize') || url.includes('oauth') || url.includes('login'))) {
          oauthUrl = url;
        }
      }
    });

    const page = await context.newPage();

    // TENTATIVA 1: acesso direto a página protegida (mTLS direto)
    console.log('Tentativa 1: Acesso direto mTLS...');
    await page.goto('https://cav.receita.fazenda.gov.br/eCAC/publico/extrato/mrelconta.asp', {
      waitUntil: 'load', timeout: 30000,
    });
    await page.waitForTimeout(2000);
    const urlDireto = page.url();
    console.log('URL após acesso direto:', urlDireto);

    // Se não redirecionou pro login, está autenticado!
    if (!urlDireto.includes('login') && !urlDireto.includes('autenticacao')) {
      console.log('Autenticado via mTLS direto!');
      return await extrairTodosDados(context);
    }

    // TENTATIVA 2: navega pro login e intercepta OAuth
    console.log('Tentativa 2: Login page + intercept OAuth...');
    await page.goto('https://cav.receita.fazenda.gov.br/autenticacao/login', {
      waitUntil: 'load', timeout: 45000,
    });
    await page.waitForTimeout(5000);
    console.log('URL login:', page.url());

    // Log form1 e botões
    const debug = await page.evaluate(() => {
      const form = document.getElementById('form1');
      const btns = Array.from(document.querySelectorAll('button, input[type=submit]')).map(b => ({
        text: b.textContent?.trim().substring(0, 50),
        cls: b.className?.substring(0, 50),
        id: b.id,
        type: b.type,
      }));
      const iframes = Array.from(document.querySelectorAll('iframe')).map(f => ({ src: f.src, id: f.id }));
      return {
        formHtml: form ? form.outerHTML.substring(0, 2000) : 'sem form1',
        botoes: btns,
        iframes,
        bodyText: document.body.innerText?.substring(0, 500),
      };
    });
    console.log('DEBUG:', JSON.stringify(debug));

    // Tenta clicar botão de login pela classe br-button (Design System Gov.br)
    const seletoresBotao = [
      '.br-button.primary',
      'button.br-button',
      'button[class*="primary"]',
      'button[class*="login"]',
      'button[class*="govbr"]',
      'button[id*="login"]',
      'button[id*="govbr"]',
      'button[id*="gov"]',
      '#btn-login',
      '#btnLogin',
      'button:has-text("Entrar")',
      'button:has-text("Acessar")',
      'button',  // qualquer botão
    ];

    for (const sel of seletoresBotao) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 1000 })) {
          const txt = await el.textContent().catch(() => '');
          console.log('Clicando:', sel, txt?.trim());
          await el.click();
          await page.waitForTimeout(3000);
          const urlPos = page.url();
          console.log('URL após clique:', urlPos);
          if (!urlPos.includes('/autenticacao/login')) break;
        }
      } catch {}
    }

    // Se capturou URL OAuth, navega direto
    if (oauthUrl) {
      console.log('Usando OAuth URL capturada:', oauthUrl.substring(0, 200));
      await page.goto(oauthUrl, { waitUntil: 'load', timeout: 30000 });
    }

    // PASSO 3: Se estiver em gov.br, seleciona certificado
    await page.waitForTimeout(3000);
    const urlAtual = page.url();
    console.log('URL atual:', urlAtual);

    if (urlAtual.includes('gov.br') && urlAtual.includes('acesso')) {
      // Log página do acesso.gov.br
      const debugAcesso = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, a, h1, h2, h3')).map(el => ({
          tag: el.tagName,
          text: el.textContent?.trim().substring(0, 60),
          href: el.getAttribute('href') || '',
          cls: el.className?.substring(0, 40),
        })).filter(e => e.text);
      });
      console.log('ACESSO.GOV.BR elementos:', JSON.stringify(debugAcesso.slice(0, 20)));

      const certSels = [
        'text=Certificado Digital',
        'button:has-text("Certificado")',
        'a:has-text("Certificado")',
        '[href*="certificado"]',
        '[class*="certificate"]',
      ];
      for (const sel of certSels) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 })) {
            console.log('Cert encontrado:', sel);
            await el.click();
            break;
          }
        } catch {}
      }

      await page.waitForURL(/cav\.receita\.fazenda\.gov\.br(?!.*login)/, { timeout: 90000 });
      console.log('Autenticado!', page.url());
    }

    return await extrairTodosDados(context);

  } finally {
    await browser.close();
  }
}

async function extrairTodosDados(context) {
  return {
    situacaoFiscal: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/extrato/mrelconta.asp', 'Situação Fiscal'),
    debitos: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/extrato/DebitosConsulta.asp', 'Débitos'),
    caixaPostal: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/mensagens/Mensagens.asp', 'Caixa Postal'),
    declaracoes: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/declaracoes/Declaracoes.asp', 'Declarações'),
    parcelamentos: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/extrato/parcelamento.asp', 'Parcelamentos'),
  };
}

async function extrairPagina(context, url, nome) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    return { sucesso: true, titulo: await page.title(), conteudo: ((await page.locator('body').textContent()) || '').trim().substring(0, 5000) };
  } catch (e) {
    return { sucesso: false, erro: e.message };
  } finally {
    await page.close();
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Orbi e-CAC Scraper v5.0 porta ' + PORT));
