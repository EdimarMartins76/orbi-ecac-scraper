const express = require('express');
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const crypto = require('crypto');

// Ativa modo stealth (esconde que é headless/bot do hcaptcha)
chromium.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: '50mb' }));
const API_KEY = process.env.API_KEY;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', versao: '7.0.0', timestamp: new Date().toISOString() });
});

function autenticar(req, res, next) {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) return res.status(401).json({ erro: 'Chave inválida' });
  next();
}

app.post('/ecac/consultar', autenticar, async (req, res) => {
  const { pfxBase64, pfxSenha, cnpj } = req.body;
  if (!pfxBase64 || !pfxSenha) return res.status(400).json({ sucesso: false, erro: 'pfxBase64 e pfxSenha obrigatórios' });
  const pfxPath = '/tmp/cert_' + crypto.randomUUID() + '.pfx';
  console.log('[' + new Date().toISOString() + '] v7 Consulta CNPJ ' + (cnpj || ''));
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

    // Captura requests para encontrar OAuth URL
    let oauthUrl = null;
    context.on('request', req => {
      const url = req.url();
      if (url.includes('sso.acesso.gov.br') || (url.includes('acesso.gov.br') && (url.includes('authorize') || url.includes('oauth') || url.includes('login')))) {
        console.log('OAuth request:', url.substring(0, 250));
        if (!oauthUrl) oauthUrl = url;
      }
    });

    const page = await context.newPage();

    // ESTRATÉGIA 1: Navega na página informativa do Gov.br sobre e-CAC
    // Nessa página, "Certificado Digital" vai para URL de auth real
    console.log('Acessando página Gov.br com link de certificado...');
    await page.goto('https://www.gov.br/receitafederal/pt-br/canais_atendimento/atendimento-virtual/acesso-govbr', {
      waitUntil: 'load', timeout: 30000,
    });
    await page.waitForTimeout(3000);
    console.log('URL:', page.url());

    // Pega TODOS os links da página e loga
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a[href]')).map(a => ({
        txt: a.textContent?.trim().substring(0, 60),
        href: a.href,
      })).filter(l => l.txt)
    );
    console.log('LINKS:', JSON.stringify(links.filter(l =>
      l.txt.toLowerCase().includes('certificado') ||
      l.txt.toLowerCase().includes('acesso') ||
      l.href.includes('acesso.gov.br') ||
      l.href.includes('cav.receita') ||
      l.href.includes('sso.')
    )));

    // Tenta clicar no link de certificado
    const certLinks = links.filter(l =>
      l.href.includes('sso.acesso.gov.br') ||
      l.href.includes('acesso.gov.br/authorize') ||
      (l.href.includes('acesso.gov.br') && !l.href.includes('www.gov.br')) ||
      l.txt.toLowerCase().includes('certificado digital')
    );

    if (certLinks.length > 0) {
      console.log('Clicando link certificado:', certLinks[0]);
      await page.goto(certLinks[0].href, { waitUntil: 'load', timeout: 30000 });
    } else {
      // Tenta clicar pelo texto
      try {
        await page.locator('text=Certificado Digital').first().click();
        await page.waitForTimeout(3000);
      } catch {}
    }

    console.log('URL após clique cert:', page.url());
    await page.waitForTimeout(2000);

    // ESTRATÉGIA 2: Se captamos OAuth URL, vai direto
    if (!oauthUrl && page.url().includes('acesso.gov.br')) {
      oauthUrl = page.url();
    }

    // ESTRATÉGIA 3: Tenta login page normal (com stealth)
    if (!oauthUrl) {
      console.log('Tentando login page com stealth...');
      await page.goto('https://cav.receita.fazenda.gov.br/autenticacao/login', { waitUntil: 'load', timeout: 45000 });
      await page.waitForTimeout(12000); // espera mais com stealth

      const botoes = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role="button"]')).map(b => ({
          txt: b.textContent?.trim().substring(0, 50),
          cls: b.className?.substring(0, 50),
        }))
      );
      console.log('BOTÕES (stealth):', JSON.stringify(botoes));

      // Tenta clicar
      for (const sel of ['button', '[role="button"]']) {
        try {
          const btns = await page.locator(sel).all();
          for (const btn of btns) {
            const txt = (await btn.textContent() || '').toLowerCase();
            if (txt.includes('entrar') || txt.includes('gov') || txt.includes('login')) {
              console.log('Clicando com stealth:', txt);
              await btn.click();
              await page.waitForTimeout(3000);
              break;
            }
          }
        } catch {}
      }
    }

    // ESTRATÉGIA 4: OAuth URL direta (melhor palpite)
    if (!oauthUrl) {
      const nonce = crypto.randomBytes(16).toString('hex');
      const state = crypto.randomBytes(16).toString('hex');
      oauthUrl = 'https://sso.acesso.gov.br/authorize' +
        '?response_type=code' +
        '&client_id=cav.receita.fazenda.gov.br' +
        '&scope=openid+profile+email+govbr_confiabilidades' +
        '&redirect_uri=https%3A%2F%2Fcav.receita.fazenda.gov.br%2Fautenticacao%2Fcallback%2Fgovbr' +
        '&nonce=' + nonce +
        '&state=' + state;
      console.log('Usando OAuth URL direta:', oauthUrl.substring(0, 200));
    }

    // Navega para OAuth URL
    console.log('Navegando OAuth:', oauthUrl.substring(0, 200));
    await page.goto(oauthUrl, { waitUntil: 'load', timeout: 30000 });
    await page.waitForTimeout(3000);
    console.log('URL pós-OAuth:', page.url());

    // Se estiver em acesso.gov.br, procura e clica em certificado
    if (page.url().includes('acesso.gov.br')) {
      await page.waitForTimeout(5000);
      const elsAcesso = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, a, [role="button"]'))
          .filter(el => el.textContent?.toLowerCase().includes('certificado'))
          .map(el => ({ tag: el.tagName, txt: el.textContent?.trim().substring(0, 60), href: el.getAttribute('href') || '' }))
      );
      console.log('ACESSO GOV.BR elementos cert:', JSON.stringify(elsAcesso));

      for (const sel of ['text=Certificado Digital', 'button:has-text("Certificado")', 'a:has-text("Certificado")']) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 })) {
            console.log('Clicando certificado:', sel);
            await el.click();
            break;
          }
        } catch {}
      }

      // Aguarda retorno ao e-CAC
      try {
        await page.waitForURL(/cav\.receita\.fazenda\.gov\.br(?!.*login)/, { timeout: 90000 });
        console.log('AUTENTICADO!', page.url());
      } catch(e) {
        console.log('Timeout aguardando callback:', page.url());
      }
    }

    // Extrai dados
    const urlFinal = page.url();
    console.log('URL final:', urlFinal);

    const autenticado = urlFinal.includes('cav.receita.fazenda.gov.br') && !urlFinal.includes('login') && !urlFinal.includes('Error');
    console.log('Autenticado:', autenticado);

    return await extrairDados(context, autenticado);

  } finally {
    await browser.close();
  }
}

async function extrairDados(context, autenticado) {
  // Tenta extrair dados reais se autenticado
  const dados = {};
  if (autenticado) {
    const paginas = [
      { nome: 'situacaoFiscal', url: 'https://cav.receita.fazenda.gov.br/eCAC/servicos/situacaofiscal' },
      { nome: 'debitos', url: 'https://cav.receita.fazenda.gov.br/eCAC/servicos/dividas' },
      { nome: 'caixaPostal', url: 'https://cav.receita.fazenda.gov.br/eCAC/servicos/caixapostal' },
      { nome: 'declaracoes', url: 'https://cav.receita.fazenda.gov.br/eCAC/servicos/declaracoes' },
    ];
    for (const { nome, url } of paginas) {
      dados[nome] = await extrairPagina(context, url, nome);
    }
  } else {
    // Retorna dados básicos indicando não autenticado
    dados.statusAuth = { sucesso: false, conteudo: 'Autenticação pendente. O e-CAC requer login via Gov.br com certificado digital.' };
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
    console.log(nome, '| URL:', page.url(), '| Título:', titulo, '| Conteudo[:100]:', conteudo.substring(0, 100));
    return { sucesso: true, titulo, urlFinal: page.url(), conteudo: conteudo.substring(0, 5000) };
  } catch (e) {
    return { sucesso: false, erro: e.message };
  } finally {
    await page.close();
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Orbi e-CAC Scraper v7.0 (stealth) porta ' + PORT));
