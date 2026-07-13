const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));
const API_KEY = process.env.API_KEY;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', versao: '4.0.0', timestamp: new Date().toISOString() });
});

function autenticar(req, res, next) {
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ erro: 'Chave inválida' });
  }
  next();
}

app.post('/ecac/consultar', autenticar, async (req, res) => {
  const { pfxBase64, pfxSenha, cnpj } = req.body;
  if (!pfxBase64 || !pfxSenha) return res.status(400).json({ sucesso: false, erro: 'pfxBase64 e pfxSenha obrigatórios' });
  const pfxPath = '/tmp/cert_' + crypto.randomUUID() + '.pfx';
  console.log('[' + new Date().toISOString() + '] Consulta CNPJ ' + (cnpj || ''));
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

    const page = await context.newPage();

    // PASSO 1: Acessa e-CAC
    console.log('Acessando e-CAC...');
    await page.goto('https://cav.receita.fazenda.gov.br/autenticacao/login', { waitUntil: 'load', timeout: 45000 });
    
    // Aguarda JS renderizar completamente (6 segundos)
    await page.waitForTimeout(6000);
    console.log('URL:', page.url(), '| Título:', await page.title());

    // Debug form1
    const form1 = await page.evaluate(() => {
      const f = document.getElementById('form1');
      return f ? f.outerHTML.substring(0, 3000) : 'form1 não encontrado';
    });
    console.log('FORM1:', form1);

    // Debug todos os buttons
    const botoes = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).map(el => ({
        tag: el.tagName,
        text: (el.textContent || el.value || '').trim().substring(0, 80),
        cls: (el.className || '').substring(0, 80),
        id: el.id,
        type: el.type || '',
        onclick: (el.getAttribute('onclick') || '').substring(0, 100),
      }));
    });
    console.log('BOTÕES:', JSON.stringify(botoes));

    // PASSO 2: Clica no botão de login
    // Tenta botões primeiro (não links informativo)
    let clicou = false;
    
    // Espera aparecer algum botão
    try {
      await page.waitForSelector('button', { timeout: 5000 });
    } catch {}

    // Tenta botões com texto de login
    const textosBotao = ['entrar', 'login', 'acessar', 'gov.br', 'govbr'];
    const todosBotoes = await page.locator('button').all();
    for (const btn of todosBotoes) {
      try {
        const txt = (await btn.textContent() || '').toLowerCase().trim();
        const cls = (await btn.getAttribute('class') || '').toLowerCase();
        if (textosBotao.some(t => txt.includes(t) || cls.includes(t))) {
          console.log('Clicando botão:', txt, cls);
          await btn.click();
          clicou = true;
          break;
        }
      } catch {}
    }

    // Se não achou botão, tenta o form action diretamente
    if (!clicou) {
      const formAction = await page.evaluate(() => {
        const f = document.getElementById('form1') || document.querySelector('form');
        return f ? (f.action || f.getAttribute('action') || '') : '';
      });
      console.log('Form action:', formAction);
      
      if (formAction && formAction.includes('acesso.gov.br')) {
        console.log('Submetendo form diretamente para:', formAction);
        await page.evaluate(() => {
          const f = document.getElementById('form1') || document.querySelector('form');
          if (f) f.submit();
        });
        clicou = true;
      }
    }

    // Último recurso: submete o form
    if (!clicou) {
      console.log('Tentando submit do form1...');
      await page.evaluate(() => {
        const f = document.getElementById('form1');
        if (f) f.submit();
        else {
          const btn = document.querySelector('button[type="submit"]');
          if (btn) btn.click();
        }
      });
      clicou = true;
    }

    // PASSO 3: Aguarda redirect para qualquer URL diferente do login
    await page.waitForURL(url => !String(url).includes('/autenticacao/login'), { timeout: 30000 });
    console.log('Redirecionado para:', page.url());

    // PASSO 4: Se em gov.br, seleciona certificado
    await page.waitForTimeout(3000);
    const urlPos = page.url();
    console.log('URL pós-redirect:', urlPos);

    if (urlPos.includes('gov.br')) {
      const seletoresCert = [
        'text=Certificado Digital',
        'button:has-text("Certificado")',
        'a:has-text("Certificado")',
        '[href*="certificado"]',
        '[data-*="certificado"]',
      ];
      for (const sel of seletoresCert) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 3000 })) {
            console.log('Certificado encontrado:', sel);
            await el.click();
            break;
          }
        } catch {}
      }

      // Aguarda retorno ao e-CAC autenticado
      await page.waitForURL(/cav\.receita\.fazenda\.gov\.br(?!.*login)/, { timeout: 90000 });
      console.log('Autenticado!', page.url());
    }

    // PASSO 5: Extrai dados
    return {
      situacaoFiscal: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/extrato/mrelconta.asp', 'Situação Fiscal'),
      debitos: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/extrato/DebitosConsulta.asp', 'Débitos'),
      caixaPostal: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/mensagens/Mensagens.asp', 'Caixa Postal'),
      declaracoes: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/declaracoes/Declaracoes.asp', 'Declarações'),
      parcelamentos: await extrairPagina(context, 'https://cav.receita.fazenda.gov.br/eCAC/publico/extrato/parcelamento.asp', 'Parcelamentos'),
    };

  } finally {
    await browser.close();
  }
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
app.listen(PORT, () => console.log('Orbi e-CAC Scraper v4.0 porta ' + PORT));
