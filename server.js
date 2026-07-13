const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

const API_KEY = process.env.API_KEY;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', servico: 'Orbi e-CAC Scraper', versao: '2.0.0', timestamp: new Date().toISOString() });
});

function autenticar(req, res, next) {
  if (API_KEY) {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) return res.status(401).json({ erro: 'Chave de API inválida' });
  }
  next();
}

app.post('/ecac/consultar', autenticar, async (req, res) => {
  const { pfxBase64, pfxSenha, cnpj } = req.body;
  if (!pfxBase64 || !pfxSenha) {
    return res.status(400).json({ sucesso: false, erro: 'pfxBase64 e pfxSenha são obrigatórios' });
  }
  const tempId = crypto.randomUUID();
  const pfxPath = '/tmp/cert_' + tempId + '.pfx';
  console.log('[' + new Date().toISOString() + '] Iniciando consulta e-CAC' + (cnpj ? ' CNPJ ' + cnpj : ''));
  try {
    fs.writeFileSync(pfxPath, Buffer.from(pfxBase64, 'base64'));
    const resultado = await consultarECAC(pfxPath, pfxSenha);
    res.json({ sucesso: true, dados: resultado, consultadoEm: new Date().toISOString() });
  } catch (erro) {
    console.error('[ERRO]', erro.message);
    res.status(500).json({ sucesso: false, erro: erro.message });
  } finally {
    try { fs.unlinkSync(pfxPath); } catch {}
  }
});

async function clicarGovBr(page, todosLinks) {
  // Primeiro tenta link direto para acesso.gov.br (OAuth)
  if (todosLinks) {
    const linkOAuth = todosLinks.find(l =>
      l.href && l.href.includes('acesso.gov.br') &&
      !l.href.includes('receitafederal') &&
      !l.href.includes('canais_atendimento')
    );
    if (linkOAuth) {
      console.log('Navegando direto para OAuth:', linkOAuth.href);
      await page.goto(linkOAuth.href, { waitUntil: 'load', timeout: 30000 });
      return true;
    }
  }

  // Seletores priorizados
  const seletores = [
    'a[href*="sso.acesso.gov.br"]',
    'a[href*="acesso.gov.br/authorize"]',
    'a[href*="acesso.gov.br/login"]',
    'a[href*="acesso.gov.br"]:not([href*="receitafederal"]):not([href*="canais"])',
    'button.btn:has-text("Gov.br")',
    'a.btn:has-text("Gov.br")',
    '.login-govbr',
    '[data-govbr]',
  ];

  for (const sel of seletores) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 2000 })) {
        const href = await el.getAttribute('href').catch(() => '');
        console.log('Clicando:', sel, 'href=', href);
        await el.click();
        return true;
      }
    } catch {}
  }

  const html = await page.content();
  throw new Error('Link OAuth Gov.br não encontrado. HTML: ' + html.substring(0, 800));
}

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
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();

    // PASSO 1: Acessa e-CAC
    console.log('Acessando e-CAC...');
    await page.goto('https://cav.receita.fazenda.gov.br/autenticacao/login', {
      waitUntil: 'load',
      timeout: 45000,
    });

    console.log('URL atual:', page.url());
    console.log('Título:', await page.title());

    // Log todos os links da página para identificar o botão correto
    const todosLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a, button')).map(el => ({
        tag: el.tagName,
        text: el.textContent?.trim().substring(0, 50),
        href: el.getAttribute('href') || '',
        classes: el.className || '',
      }));
    });
    console.log('LINKS DA PÁGINA:', JSON.stringify(todosLinks.slice(0, 20)));

    // PASSO 2: Encontra e clica no link de login correto (que vai para acesso.gov.br)
    console.log('Buscando link de login Gov.br...');
    await clicarGovBr(page, todosLinks);

    // Aguarda redirect para acesso.gov.br (SSO)
    await page.waitForURL(/acesso\.gov\.br/, { timeout: 30000 });
    console.log('Em acesso.gov.br:', page.url());

    // PASSO 3: Seleciona Certificado Digital
    await page.waitForTimeout(3000);
    console.log('Selecionando certificado...');
    const seletoresCert = [
      'text=Certificado Digital',
      'button:has-text("Certificado")',
      'a:has-text("Certificado")',
      '[data-type="certificate"]',
      '[class*="certificate"]',
      'text=certificado',
    ];
    for (const sel of seletoresCert) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 3000 })) {
          console.log('Opção certificado encontrada:', sel);
          await el.click();
          break;
        }
      } catch {}
    }

    // Aguarda retorno ao e-CAC
    await page.waitForURL(/cav\.receita\.fazenda\.gov\.br/, { timeout: 60000 });
    console.log('Autenticado! URL:', page.url());

    // PASSO 4: Extrai dados
    const dados = {
      situacaoFiscal: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/extrato/mrelconta.asp', 'Situação Fiscal'),
      debitos: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/extrato/DebitosConsulta.asp', 'Débitos'),
      caixaPostal: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/mensagens/Mensagens.asp', 'Caixa Postal'),
      declaracoes: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/declaracoes/Declaracoes.asp', 'Declarações'),
      parcelamentos: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/extrato/parcelamento.asp', 'Parcelamentos'),
    };

    return dados;

  } finally {
    await browser.close();
  }
}

async function extrairPagina(context, url, nome) {
  const page = await context.newPage();
  try {
    console.log('Extraindo: ' + nome);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const titulo = await page.title();
    const conteudo = await page.locator('body').textContent();
    return { sucesso: true, titulo, conteudo: (conteudo || '').trim().substring(0, 5000) };
  } catch (e) {
    console.error('Erro em ' + nome + ':', e.message);
    return { sucesso: false, erro: e.message };
  } finally {
    await page.close();
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Orbi e-CAC Scraper v2.0 rodando na porta ' + PORT);
});
