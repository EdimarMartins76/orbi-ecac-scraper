const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

const API_KEY = process.env.API_KEY;

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    servico: 'Orbi e-CAC Scraper',
    versao: '1.0.0',
    timestamp: new Date().toISOString(),
  });
});

// Middleware autenticação
function autenticar(req, res, next) {
  if (API_KEY) {
    const key = req.headers['x-api-key'];
    if (key !== API_KEY) {
      return res.status(401).json({ erro: 'Chave de API inválida' });
    }
  }
  next();
}

// Endpoint principal
app.post('/ecac/consultar', autenticar, async (req, res) => {
  const { pfxBase64, pfxSenha, cnpj } = req.body;

  if (!pfxBase64 || !pfxSenha) {
    return res.status(400).json({
      sucesso: false,
      erro: 'pfxBase64 e pfxSenha são obrigatórios',
    });
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

async function consultarECAC(pfxPath, senha) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
  });

  try {
    const context = await browser.newContext({
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
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // PASSO 2: Clica em "Entrar com Gov.br"
    console.log('Clicando em Gov.br...');
    await page.locator('a[href*="acesso.gov.br"], a[href*="gov.br"], button:has-text("gov.br")').first().click();
    await page.waitForURL(/acesso\.gov\.br/, { timeout: 30000 });

    // PASSO 3: Seleciona Certificado Digital
    console.log('Selecionando certificado digital...');
    await page.waitForTimeout(2000);
    await page.locator('text=Certificado Digital, button:has-text("Certificado"), [data-type="certificate"]').first().click();

    // Aguarda autenticação mTLS e retorno ao e-CAC
    await page.waitForURL(/cav\.receita\.fazenda\.gov\.br/, { timeout: 60000 });
    console.log('Autenticado!');

    // PASSO 4: Extrai todos os dados
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
    return {
      sucesso: true,
      titulo,
      conteudo: (conteudo || '').trim().substring(0, 5000),
    };
  } catch (e) {
    console.error('Erro em ' + nome + ':', e.message);
    return { sucesso: false, erro: e.message };
  } finally {
    await page.close();
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log('Orbi e-CAC Scraper rodando na porta ' + PORT);
});
