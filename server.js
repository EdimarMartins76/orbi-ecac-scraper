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

async function clicarGovBr(page) {
  // Tenta múltiplos seletores possíveis para o botão Gov.br
  const seletores = [
    'a[href*="acesso.gov.br"]',
    'a[href*="sso.acesso.gov.br"]',
    'button:has-text("Gov.br")',
    'a:has-text("Gov.br")',
    'button:has-text("gov.br")',
    'a:has-text("gov.br")',
    '[class*="govbr"]',
    '[id*="govbr"]',
    'input[value*="gov"]',
    'button[type="submit"]',
  ];
  for (const sel of seletores) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 3000 })) {
        console.log('Botão Gov.br encontrado com seletor: ' + sel);
        await el.click();
        return true;
      }
    } catch {}
  }
  // Última tentativa: pega o HTML pra debug
  const html = await page.content();
  const snippet = html.substring(0, 3000);
  console.log('HTML da página (primeiros 3000 chars):', snippet);
  throw new Error('Botão Gov.br não encontrado. HTML: ' + snippet.substring(0, 500));
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
    await page.goto('https://cav.receita.fazenda.gov.br', {
      waitUntil: 'networkidle',
      timeout: 45000,
    });

    console.log('URL atual:', page.url());
    console.log('Título:', await page.title());

    // PASSO 2: Clica em Gov.br
    console.log('Buscando botão Gov.br...');
    await clicarGovBr(page);

    // Aguarda redirect para acesso.gov.br
    await page.waitForURL(/acesso\.gov\.br|gov\.br/, { timeout: 30000 });
    console.log('Em Gov.br:', page.url());

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
