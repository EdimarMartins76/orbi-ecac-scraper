const express = require('express');
const { chromium } = require('playwright');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '50mb' }));

const API_KEY = process.env.API_KEY;

app.get('/health', (req, res) => {
  res.json({ status: 'ok', servico: 'Orbi e-CAC Scraper', versao: '3.0.0', timestamp: new Date().toISOString() });
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
  console.log('[' + new Date().toISOString() + '] Iniciando consulta CNPJ ' + (cnpj || ''));
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

    // PASSO 1: Acessa login e-CAC
    console.log('Acessando e-CAC login...');
    await page.goto('https://cav.receita.fazenda.gov.br/autenticacao/login', {
      waitUntil: 'load',
      timeout: 45000,
    });

    // Aguarda JS renderizar os botões
    await page.waitForTimeout(3000);
    console.log('URL:', page.url(), '| Título:', await page.title());

    // Debug: loga TODOS elementos interativos com texto
    const elementos = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'))
        .map(el => ({
          tag: el.tagName,
          text: (el.textContent || el.value || '').trim().substring(0, 80),
          href: el.getAttribute('href') || '',
          onclick: (el.getAttribute('onclick') || '').substring(0, 100),
          cls: (el.className || '').substring(0, 60),
          id: el.id || '',
        }))
        .filter(el => el.text || el.href || el.onclick);
    });
    console.log('ELEMENTOS INTERATIVOS:', JSON.stringify(elementos));

    // PASSO 2: Clica no botão de login Gov.br
    // Tenta pelo texto "Entrar" ou "Gov.br" ou "govbr"
    let clicou = false;

    // Estratégia 1: espera botão com texto Entrar aparecer
    try {
      await page.waitForSelector('button:has-text("Entrar"), a:has-text("Entrar"), [class*="govbr"], [id*="govbr"]', { timeout: 5000 });
    } catch {}

    // Estratégia 2: tenta vários seletores
    const tentativas = [
      '[class*="govbr"]',
      '[id*="govbr"]',
      'button:has-text("Entrar")',
      'a:has-text("Entrar")',
      'button:has-text("Gov")',
      'a:has-text("Gov")',
      '[data-login]',
      'form button[type="submit"]',
      'input[type="submit"]',
    ];

    for (const sel of tentativas) {
      try {
        const el = page.locator(sel).first();
        if (await el.isVisible({ timeout: 2000 })) {
          const txt = await el.textContent().catch(() => '');
          console.log('Clicando:', sel, '| texto:', txt?.trim());
          await el.click();
          clicou = true;
          break;
        }
      } catch {}
    }

    if (!clicou) {
      // Último recurso: clica no primeiro link que não seja CSS/JS/img
      const todosLinks = await page.locator('a').all();
      for (const link of todosLinks) {
        const href = await link.getAttribute('href').catch(() => '');
        const txt = await link.textContent().catch(() => '');
        if (href && !href.endsWith('.css') && !href.endsWith('.js') && txt?.trim()) {
          console.log('Último recurso - clicando link:', href, txt?.trim());
          await link.click();
          clicou = true;
          break;
        }
      }
    }

    // PASSO 3: Aguarda qualquer redirect
    await page.waitForURL(url => !String(url).includes('autenticacao/login'), { timeout: 30000 });
    console.log('Redirecionado para:', page.url());

    // PASSO 4: Se estiver em acesso.gov.br, seleciona certificado
    const urlAtual = page.url();
    if (urlAtual.includes('acesso.gov.br') || urlAtual.includes('gov.br')) {
      await page.waitForTimeout(3000);
      console.log('Buscando opção de certificado...');
      const seletoresCert = [
        'text=Certificado Digital',
        'a:has-text("Certificado")',
        'button:has-text("Certificado")',
        '[class*="certificate"]',
        '[href*="certificado"]',
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
      // Aguarda retorno ao e-CAC
      await page.waitForURL(/cav\.receita\.fazenda\.gov\.br(?!.*login)/, { timeout: 60000 });
      console.log('Autenticado! URL:', page.url());
    }

    // PASSO 5: Extrai dados
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
    console.log('Extraindo:', nome);
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
    const titulo = await page.title();
    const conteudo = await page.locator('body').textContent();
    return { sucesso: true, titulo, conteudo: (conteudo || '').trim().substring(0, 5000) };
  } catch (e) {
    return { sucesso: false, erro: e.message };
  } finally {
    await page.close();
  }
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log('Orbi e-CAC Scraper v3.0 rodando na porta ' + PORT));
