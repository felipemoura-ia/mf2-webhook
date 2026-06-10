const express = require('express')
const cors = require('cors')
require('dotenv').config()

const { createClient } = require('@supabase/supabase-js')

const app = express()
app.use(cors())
app.use(express.json({ limit: '10mb' }))

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
)

const ADMIN_PHONE = process.env.ADMIN_PHONE || '5511983859141'
const processingQueue = new Map()

app.get('/', (req, res) => {
  res.json({ status: 'MF2 Webhook Server online', version: '1.3.0' })
})

app.post('/webhook/whatsapp', async (req, res) => {
  res.json({ received: true })

  try {
    const payload = req.body
    const event = payload.event
    console.log(`[WEBHOOK] Evento recebido: ${event}`)
    if (event !== 'messages.upsert') return

    const data = payload.data
    if (!data) return
    if (data.key?.fromMe) return

    const phone = data.key?.remoteJid
      ?.replace('@s.whatsapp.net', '')
      ?.replace('@c.us', '')
      ?.replace(/[^0-9]/g, '')

    const content = data.message?.conversation
      || data.message?.extendedTextMessage?.text
      || data.message?.imageMessage?.caption
      || '[mídia]'

    if (!phone || phone.includes('-')) {
      console.log('[WEBHOOK] Ignorando mensagem de grupo ou sem telefone')
      return
    }

    if (processingQueue.get(phone)) {
      console.log(`[WEBHOOK] Aguardando processamento anterior para +${phone}`)
      await new Promise(r => setTimeout(r, 2000))
    }
    processingQueue.set(phone, true)

    try {
      await processMessage({ phone, content, payload, data })
    } finally {
      processingQueue.delete(phone)
    }
  } catch (err) {
    console.error('[WEBHOOK] Erro geral:', err)
  }
})

async function processMessage({ phone, content, payload, data }) {
  console.log(`[WEBHOOK] Processando mensagem de +${phone}: ${content.slice(0, 50)}`)

  const instanceName = payload.instance
  const { data: instance } = await supabase
    .from('whatsapp_instances')
    .select('organization_id')
    .eq('instance_name', instanceName)
    .single()

  if (!instance?.organization_id) {
    console.log(`[WEBHOOK] Instância não encontrada: ${instanceName}`)
    return
  }

  const orgId = instance.organization_id

  let lead
  const { data: existingLead } = await supabase
    .from('leads')
    .select('*')
    .eq('organization_id', orgId)
    .eq('phone', phone)
    .maybeSingle()

  if (existingLead) {
    lead = existingLead
    console.log(`[WEBHOOK] Lead existente: ${lead.id}`)
  } else {
    const pushName = data.pushName || null
    const { data: newLead, error } = await supabase
      .from('leads')
      .insert({ organization_id: orgId, phone, name: pushName, status: 'novo' })
      .select()
      .single()

    if (error) {
      console.error('[WEBHOOK] Erro ao criar lead:', error)
      return
    }
    lead = newLead
    console.log(`[WEBHOOK] Novo lead criado: ${lead.id}`)
  }

  // Busca histórico ANTES de registrar a mensagem atual
  const { data: history } = await supabase
    .from('lead_messages')
    .select('direction, content, created_at')
    .eq('lead_id', lead.id)
    .order('created_at', { ascending: true })
    .limit(20)

  // Registra mensagem recebida
  await supabase.from('lead_messages').insert({
    lead_id: lead.id,
    organization_id: orgId,
    direction: 'inbound',
    content,
    channel: 'whatsapp',
  })
  console.log(`[WEBHOOK] Mensagem registrada para lead ${lead.id}`)

  const { data: agent } = await supabase
    .from('ai_agents')
    .select('*')
    .eq('organization_id', orgId)
    .eq('active', true)
    .maybeSingle()

  if (!agent) {
    console.log('[WEBHOOK] Agente IA inativo ou não configurado')
    return
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('[WEBHOOK] Chave Anthropic não configurada')
    return
  }

  // Verifica palavras de pausa por palavra-chave
  const pauseKeywords = agent.pause_keywords || ['humano', 'atendente', 'pessoa', 'gerente']
  const shouldPause = pauseKeywords.some(kw =>
    content.toLowerCase().includes(kw.toLowerCase())
  )

  if (shouldPause) {
    console.log('[WEBHOOK] Pausa automática por palavra-chave')
    const fallback = agent.fallback_message || 'Deixa eu verificar isso com nossa equipe e retorno em breve!'
    await supabase.from('lead_messages').insert({
      lead_id: lead.id,
      organization_id: orgId,
      direction: 'outbound',
      content: fallback,
      channel: 'whatsapp',
    })
    await sendWhatsApp(phone, fallback)
    await notifyAdmin({ phone, lead, content, reason: 'palavra-chave de pausa' })
    await supabase.from('ai_agent_logs').insert({
      organization_id: orgId,
      lead_id: lead.id,
      action: 'pausa_automatica',
      input: content,
      output: 'Pausa por palavra-chave',
    })
    return
  }

  // Monta histórico para o Claude com alternância correta user/assistant
  const rawMessages = (history || []).map(msg => ({
    role: msg.direction === 'inbound' ? 'user' : 'assistant',
    content: msg.content,
  }))

  const dedupedMessages = []
  for (const msg of rawMessages) {
    if (dedupedMessages.length === 0 || dedupedMessages[dedupedMessages.length - 1].role !== msg.role) {
      dedupedMessages.push(msg)
    }
  }

  // Adiciona mensagem atual no final
  if (dedupedMessages.length === 0 || dedupedMessages[dedupedMessages.length - 1].role !== 'user') {
    dedupedMessages.push({ role: 'user', content })
  }

  // Banco de conhecimento
  const { data: knowledgeItems } = await supabase
    .from('knowledge_items')
    .select('question, answer, category')
    .eq('organization_id', orgId)
    .eq('active', true)
    .limit(30)

  const { data: documents } = await supabase
    .from('knowledge_documents')
    .select('name, content_text')
    .eq('organization_id', orgId)
    .eq('status', 'ready')
    .limit(5)

  let knowledgeContext = ''
  if (knowledgeItems?.length) {
    knowledgeContext += '\n\nPERGUNTAS E RESPOSTAS FREQUENTES:\n'
    knowledgeItems.forEach(item => {
      knowledgeContext += `P: ${item.question}\nR: ${item.answer}\n\n`
    })
  }
  if (documents?.length) {
    knowledgeContext += '\n\nDOCUMENTOS DE REFERÊNCIA:\n'
    documents.forEach(doc => {
      knowledgeContext += `[${doc.name}]:\n${doc.content_text?.slice(0, 2000)}\n\n`
    })
  }

  // Monta contexto do histórico em texto para reforçar memória
  const isFirstMessage = !history || history.length === 0
  let historyContext = ''

  if (!isFirstMessage && history && history.length > 0) {
    historyContext = '\n\n---\nCONTEXTO DA CONVERSA ATUAL:\n'
    historyContext += 'Esta conversa já está em andamento. Use o histórico abaixo para continuar naturalmente.\n'
    historyContext += 'NÃO use a mensagem inicial de saudação. NÃO repita perguntas já respondidas.\n\n'
    historyContext += 'Histórico recente:\n'
    history.slice(-10).forEach(msg => {
      const role = msg.direction === 'inbound' ? 'Lead' : 'Agente'
      historyContext += `${role}: ${msg.content}\n`
    })
    historyContext += `\nMensagem atual do lead: "${content}"\n`
    historyContext += '\nInstrução: responda APENAS à mensagem atual considerando tudo que já foi dito. Avance a conversa.'
  } else {
    historyContext = '\n\n---\nEsta é a PRIMEIRA mensagem desta conversa. Use a mensagem inicial de saudação.'
  }

  // Instrução de pausa via tag
  const pauseInstruction = `

---
INSTRUÇÃO DE PAUSA:
Quando decidir encaminhar para atendimento humano, inclua [PAUSA_HUMANO] no início da resposta antes do texto ao lead.
Exemplo: [PAUSA_HUMANO]Obrigado pelas informações. Vou encaminhar para a equipe da MF2 Digital.
Use [PAUSA_HUMANO] quando: lead pedir reunião, perguntar preço/proposta, demonstrar interesse em contratar, fazer pergunta técnica específica ou pedir para falar com humano.
Após encaminhar, NÃO envie mais nenhuma mensagem.`

  const systemPrompt = (agent.system_prompt || 'Você é um assistente prestativo.')
    + knowledgeContext
    + historyContext
    + pauseInstruction

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 25000)

  let aiResponse
  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: systemPrompt,
        messages: dedupedMessages,
      }),
      signal: controller.signal,
    })

    clearTimeout(timeout)

    if (!claudeRes.ok) {
      const err = await claudeRes.text()
      console.error('[WEBHOOK] Erro Claude:', err)
      await handleFallback({ phone, lead, orgId, agent, content })
      return
    }

    const claudeData = await claudeRes.json()
    aiResponse = claudeData.content?.[0]?.text
  } catch (err) {
    clearTimeout(timeout)
    if (err.name === 'AbortError') {
      console.error('[WEBHOOK] Timeout na chamada ao Claude')
    } else {
      console.error('[WEBHOOK] Erro na chamada ao Claude:', err)
    }
    await handleFallback({ phone, lead, orgId, agent, content })
    return
  }

  if (!aiResponse) {
    console.log('[WEBHOOK] Resposta vazia do Claude')
    await handleFallback({ phone, lead, orgId, agent, content })
    return
  }

  const agentWantsPause = aiResponse.includes('[PAUSA_HUMANO]')
  const cleanResponse = aiResponse.replace('[PAUSA_HUMANO]', '').trim()

  console.log(`[WEBHOOK] Resposta IA: ${cleanResponse.slice(0, 80)}`)

  await sendWhatsApp(phone, cleanResponse)

  await supabase.from('lead_messages').insert({
    lead_id: lead.id,
    organization_id: orgId,
    direction: 'outbound',
    content: cleanResponse,
    channel: 'whatsapp',
  })

  if (agentWantsPause) {
    console.log('[WEBHOOK] Agente sinalizou encaminhamento para humano')
    await notifyAdmin({ phone, lead, content, reason: 'encaminhamento pela IA' })
    await supabase.from('ai_agent_logs').insert({
      organization_id: orgId,
      lead_id: lead.id,
      action: 'pausa_por_ia',
      input: content,
      output: cleanResponse,
    })
  } else {
    await supabase.from('ai_agent_logs').insert({
      organization_id: orgId,
      lead_id: lead.id,
      action: 'resposta_automatica',
      input: content,
      output: cleanResponse,
    })
  }

  console.log(`[WEBHOOK] Resposta enviada para +${phone}`)
}

async function handleFallback({ phone, lead, orgId, agent, content }) {
  const fallback = 'Estou com uma instabilidade momentânea, mas sua mensagem foi registrada. A Carol ou o consultor de crescimento Felipe Moura vão te responder por aqui assim que possível.'
  console.log('[WEBHOOK] Enviando fallback por erro/timeout')
  await sendWhatsApp(phone, fallback)
  await supabase.from('lead_messages').insert({
    lead_id: lead.id,
    organization_id: orgId,
    direction: 'outbound',
    content: fallback,
    channel: 'whatsapp',
  })
  await notifyAdmin({ phone, lead, content, reason: 'erro/timeout na IA' })
}

async function notifyAdmin({ phone, lead, content, reason }) {
  const leadName = lead.name || `+${phone}`
  const message = `🔔 *Atendimento humano solicitado*\n\n` +
    `👤 Lead: ${leadName}\n` +
    `📱 Telefone: +${phone}\n` +
    `💬 Última mensagem: "${content.slice(0, 100)}"\n` +
    `📋 Motivo: ${reason}\n\n` +
    `Acesse o CRM para continuar o atendimento.`
  console.log(`[WEBHOOK] Notificando admin sobre pausa do lead +${phone}`)
  await sendWhatsApp(ADMIN_PHONE, message)
}

async function sendWhatsApp(phone, text) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    await fetch(`${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE_NAME}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.EVOLUTION_API_KEY,
      },
      body: JSON.stringify({ number: phone, text }),
      signal: controller.signal,
    })
    clearTimeout(timeout)
  } catch (err) {
    clearTimeout(timeout)
    console.error('[WEBHOOK] Erro ao enviar WhatsApp:', err.message)
  }
}

const PORT = process.env.PORT || 3001
app.listen(PORT, () => {
  console.log(`MF2 Webhook Server v1.3.0 rodando na porta ${PORT}`)
  console.log(`Aguardando webhooks em /webhook/whatsapp`)
})
