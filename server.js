const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));
const API_KEY = process.env.API_KEY;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', versao: '6.0.0', timestamp: new Date().toISOString() });
});

function autenticar(req, res, next) {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ erro: 'Chave inválida' });
  next();
}

app.post('/ecac/consultar', autenticar, async (req, res) => {
  const { pfxBase64, pfxSenha, cnpj } = req.body;
  if (!pfxBase64 || !pfxSenha) return res.status(400).json({ sucesso: false, erro: 'pfxBase64 e pfxSenha obrigatórios' });
  const pfxPath = '/tmp/cert_' + crypto.randomUUID() + '.pfx';
  console.log('[' + new Date().toISOString() + '] v6 Consulta CNPJ ' + (cnpj || ''));
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

    // Captura TODAS as requests para encontrar URL OAuth
    let oauthUrl = null;
    const todasRequests = [];
    context.on('request', req => {
      const url = req.url();
      todasRequests.push(url);
      if (url.includes('sso.acesso.gov.br') || (url.includes('acesso.gov.br') && url.includes('authorize'))) {
        oauthUrl = url;
        console.log('OAuth URL capturada!', url.substring(0, 200));
      }
    });

    const page = await context.newPage();

    // Navega login e-CAC
    console.log('Acessando login...');
    await page.goto('https://cav.receita.fazenda.gov.br/autenticacao/login', { waitUntil: 'load', timeout: 45000 });
    
    // Aguarda 10 segundos para JS renderizar
    await page.waitForTimeout(10000);
    console.log('URL:', page.url());

    // Extrai referências ao acesso.gov.br do HTML completo
    const htmlFull = await page.content();
    const acessoRefs = (htmlFull.match(/https?:\/\/[^"'\s]*acesso\.gov\.br[^"'\s]*/g) || []).slice(0, 10);
    const ssoRefs = (htmlFull.match(/https?:\/\/[^"'\s]*sso\.[^"'\s]*/g) || []).slice(0, 5);
    console.log('REFS ACESSO.GOV.BR no HTML:', JSON.stringify(acessoRefs));
    console.log('REFS SSO no HTML:', JSON.stringify(ssoRefs));

    // Extrai URLs dos script src
    const scriptSrcs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('script[src]')).map(s => s.src)
    );
    console.log('SCRIPTS:', JSON.stringify(scriptSrcs));

    // Busca botão no Shadow DOM recursivamente
    const shadowResult = await page.evaluate(() => {
      function findClickable(root, depth) {
        if (depth > 5) return null;
        const els = root.querySelectorAll('button, a, [role="button"], [onclick]');
        for (const el of els) {
          const txt = (el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
          if (txt.includes('entrar') || txt.includes('gov') || txt.includes('acessar') || txt.includes('login')) {
            el.click();
            return 'shadow-click:' + txt.substring(0, 50);
          }
        }
        // Recursão em shadow roots
        const allEls = root.querySelectorAll('*');
        for (const el of allEls) {
          if (el.shadowRoot) {
            const r = findClickable(el.shadowRoot, depth + 1);
            if (r) return r;
          }
        }
        return null;
      }
      return findClickable(document, 0);
    });
    console.log('Shadow DOM result:', shadowResult);

    // Se não clicou nada, tenta injetar click via JS no primeiro link visível
    if (!shadowResult) {
      await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a'));
        for (const a of links) {
          const rect = a.getBoundingClientRect();
          const txt = a.textContent?.toLowerCase() || '';
          if (rect.width > 50 && rect.height > 20 && (txt.includes('gov') || txt.includes('entrar') || txt.includes('login'))) {
            a.click();
            console.log('Clicou link:', txt);
            return;
          }
        }
      });
    }

    // Aguarda qualquer redirect
    try {
      await page.waitForURL(url => !String(url).includes('/autenticacao/login'), { timeout: 15000 });
      console.log('Redirect para:', page.url());
    } catch {
      console.log('Sem redirect após 15s. URL:', page.url());
    }

    // Se temos URL OAuth, navega direto
    if (oauthUrl) {
      console.log('Navegando OAuth URL:', oauthUrl.substring(0, 200));
      await page.goto(oauthUrl, { waitUntil: 'load', timeout: 30000 });
      await page.waitForTimeout(3000);
      console.log('URL pós-OAuth:', page.url());
    }

    // Seleciona certificado em acesso.gov.br
    if (page.url().includes('acesso.gov.br')) {
      await page.waitForTimeout(3000);
      const certEls = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button, a, [role="button"]'))
          .filter(el => el.textContent?.toLowerCase().includes('certificado'))
          .map(el => ({ txt: el.textContent?.trim(), cls: el.className }));
      });
      console.log('CERT ELS:', JSON.stringify(certEls));

      for (const sel of ['text=Certificado Digital', 'button:has-text("Certificado")', 'a:has-text("Certificado")']) {
        try {
          if (await page.locator(sel).first().isVisible({ timeout: 3000 })) {
            await page.locator(sel).first().click();
            break;
          }
        } catch {}
      }

      await page.waitForURL(/cav\.receita\.fazenda\.gov\.br(?!.*login)/, { timeout: 90000 });
      console.log('Autenticado!', page.url());
    }

    // Se ainda na página de login, mostra requests capturadas
    if (page.url().includes('login')) {
      console.log('TODAS REQUESTS:', JSON.stringify(todasRequests.filter(u => !u.includes('.css') && !u.includes('.png') && !u.includes('.jpg') && !u.includes('hcaptcha'))));
    }

    return await extrairTodosDados(context);

  } finally {
    await browser.close();
  }
}

async function extrairTodosDados(context) {
  const dados = {};
  const paginas = [
    { nome: 'situacaoFiscal', urls: ['https://cav.receita.fazenda.gov.br/eCAC/servicos/situacaofiscal', 'https://cav.receita.fazenda.gov.br/eCAC/'] },
    { nome: 'debitos', urls: ['https://cav.receita.fazenda.gov.br/eCAC/servicos/dividas'] },
    { nome: 'caixaPostal', urls: ['https://cav.receita.fazenda.gov.br/eCAC/servicos/caixapostal'] },
    { nome: 'declaracoes', urls: ['https://cav.receita.fazenda.gov.br/eCAC/servicos/declaracoes'] },
  ];

  for (const { nome, urls } of paginas) {
    for (const url of urls) {
      const r = await extrairPagina(context, url, nome);
      if (r.sucesso && r.conteudo && r.conteudo.length > 50 &&
          !r.conteudo.includes('Procuração') && !r.conteudo.includes('procurador') &&
          !r.conteudo.includes('Formulário de login')) {
        dados[nome] = r;
        break;
      }
      dados[nome] = r;
    }
  }
  return dados;
}

async function extrairPagina(context, url, nome) {
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(2000);
    const urlFinal = page.url();
    const titulo = await page.title();
    const conteudo = ((await page.locator('body').textContent()) || '').trim().substring(0, 3000);
    console.log(nome, '| URL:', urlFinal, '| Titulo:', titulo, '| Conteudo:', conteudo.substring(0, 100));
    return { sucesso: true, titulo, urlFinal, conteudo };
  } catch (e) {
    return { sucesso: false, erro: e.message };
  } finally {
    await page.close();
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Orbi e-CAC Scraper v6.0 porta ' + PORT));
