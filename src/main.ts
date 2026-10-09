import {
  waitForEvenAppBridge,
  CreateStartUpPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  RebuildPageContainer,
  StartUpPageCreateResult,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import './style.css'

declare const __APP_VERSION__: string

// ---------------------------------------------------------------------------
// 設定
// ---------------------------------------------------------------------------

/** 初期表示（ここを書き換えると既定の内容が変わる。スマホ側の編集内容が優先される） */
const DEFAULT_TEXT = '直近の○○楽しい/大変\n▶夏休み、バイト、研究、出会い'
/** 2ページモードでのページ2の初期表示 */
const DEFAULT_TEXT2 = '▶深掘りの質問\n▶最近ハマってること'

const STORAGE_KEY = 'topicshud:text'
const STORAGE_KEY_2 = 'topicshud:text2'
const STORAGE_KEY_MODE = 'topicshud:pagemode'
/** createStartUpPageContainer の文字数上限 */
const MAX_CHARS = 1000
/** グラス1画面に収まる目安 */
const FIT_CHARS = 400

/** 2ページモードのページ数 */
const PAGE_COUNT = 2
/** 2ページモード中、本文の下に「[1/2]」を出す（不要なら false） */
const SHOW_PAGE_NUMBER = true

const CONTAINER_ID = 1
const CONTAINER_NAME = 'main'
/** グラスのコンテキストメニューに出す「隠す/出す」(32 UTF-8バイト以内, ID は 1 以上) */
const MENU_TOGGLE_ID = 1
const MENU_TOGGLE_LABEL = '隠す/出す'

const BRIDGE_TIMEOUT_MS = 3000
const SYNC_DEBOUNCE_MS = 400
const TOGGLE_GUARD_MS = 600
/** スワイプ1回で複数イベントが届いても1回だけ切り替える */
const FLIP_GUARD_MS = 250

/** グラス上のスライド（上下どちらでも）として扱うイベント */
const SWIPE_EVENT_TYPES = new Set<unknown>([
  OsEventTypeList.SCROLL_TOP_EVENT,
  OsEventTypeList.SCROLL_BOTTOM_EVENT,
])

// ---------------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------------

type Link = 'connecting' | 'glasses' | 'preview' | 'error'
type PageNo = 1 | 2

let bridge: EvenAppBridge | null = null
let glassesReady = false
let text = DEFAULT_TEXT
let text2 = DEFAULT_TEXT2
/** 2ページモード（テンプルのスライドでページ1⇄2を切り替える） */
let pageMode = false
/** いまグラスに出しているページ。2ページモードでなければ常に 1 */
let page: PageNo = 1
let hidden = false
let link: Link = 'connecting'
let linkDetail = ''
let lastToggleAt = 0
let lastFlipAt = 0
let syncTimer: number | undefined
/** デバウンス中に「いまグラスに出しているページ」が編集されたか */
let syncNeedsPush = false
let sendQueue: Promise<void> = Promise.resolve()
let connecting = false

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`#${id} not found`)
  return node as T
}

const editor = el<HTMLTextAreaElement>('editor')
const editor2 = el<HTMLTextAreaElement>('editor2')
const counter = el<HTMLSpanElement>('counter')
const counter2 = el<HTMLSpanElement>('counter2')
const warn = el<HTMLParagraphElement>('warn')
const warn2 = el<HTMLParagraphElement>('warn2')
const editHeading = el<HTMLHeadingElement>('edit-h')
const card2 = el<HTMLElement>('card2')
const pageModeInput = el<HTMLInputElement>('page-mode')
const preview = el<HTMLPreElement>('preview')
const previewBox = el<HTMLDivElement>('preview-box')
const previewTag = el<HTMLSpanElement>('preview-tag')
const toggleBtn = el<HTMLButtonElement>('toggle')
const connectBtn = el<HTMLButtonElement>('connect')
const flipBtn = el<HTMLButtonElement>('flip')
const statusPill = el<HTMLSpanElement>('status')

/** 文字数カウンタと「1画面に収まらない」警告を更新する */
function renderCounter(value: string, counterEl: HTMLElement, warnEl: HTMLElement): void {
  const over = value.length > FIT_CHARS
  counterEl.textContent = `${value.length} / ${MAX_CHARS}`
  counterEl.classList.toggle('over', over)
  warnEl.hidden = !over
  warnEl.textContent = over
    ? pageMode
      ? `約${FIT_CHARS}文字を超えると1画面に収まりません（2ページモードではスライドがページ切替になるため、スクロールできません）。`
      : `約${FIT_CHARS}文字を超えると1画面に収まりません（グラス上でスワイプしてスクロールできます）。`
    : ''
}

function renderUi(): void {
  // プレビュー（グラスに実際に出る内容と同じ。非表示中は空白）
  preview.textContent = hidden ? '' : glassContent()
  previewBox.classList.toggle('is-hidden', hidden)
  previewTag.textContent = hidden
    ? '非表示中（グラスは空白）'
    : pageMode
      ? `グラスの表示イメージ（ページ ${page}/${PAGE_COUNT}）`
      : 'グラスの表示イメージ'

  // トグルボタン
  toggleBtn.textContent = hidden ? '表示する' : '非表示にする'
  toggleBtn.setAttribute('aria-pressed', String(hidden))
  toggleBtn.classList.toggle('is-active', hidden)

  // 2ページモード（スイッチ・ページ2の入力欄・切替ボタン）
  pageModeInput.checked = pageMode
  card2.hidden = !pageMode
  editHeading.textContent = pageMode ? 'ページ1を編集' : '表示内容を編集'
  flipBtn.hidden = !pageMode
  flipBtn.textContent = `ページを切り替える（いま ${page}/${PAGE_COUNT}）`

  // 文字数
  renderCounter(text, counter, warn)
  renderCounter(text2, counter2, warn2)

  // 「グラスに表示する」ボタン（接続済みなら隠す）
  connectBtn.hidden = link === 'glasses'
  connectBtn.disabled = connecting
  connectBtn.textContent = connecting ? '接続中…' : 'グラスに表示する'

  // 接続状態
  const labels: Record<Link, string> = {
    connecting: '接続確認中…',
    glasses: `グラスに接続中${linkDetail}`,
    preview: 'プレビューのみ（グラス未接続）',
    error: `グラスに表示できません${linkDetail}`,
  }
  statusPill.textContent = labels[link]
  statusPill.dataset.state = link
}

// ---------------------------------------------------------------------------
// 保存
// ---------------------------------------------------------------------------

async function saveValue(key: string, value: string): Promise<void> {
  try {
    if (bridge) await bridge.setLocalStorage(key, value)
  } catch (e) {
    console.warn('bridge.setLocalStorage failed', e)
  }
  try {
    localStorage.setItem(key, value)
  } catch {
    /* プライベートモード等では無視 */
  }
}

/** 保存値を読む。未保存なら空文字 */
async function loadValue(key: string): Promise<string> {
  let value = ''
  try {
    if (bridge) value = (await bridge.getLocalStorage(key)) ?? ''
  } catch (e) {
    console.warn('bridge.getLocalStorage failed', e)
  }
  if (!value) {
    try {
      value = localStorage.getItem(key) ?? ''
    } catch {
      /* ignore */
    }
  }
  return value
}

function saveAllText(): void {
  void saveValue(STORAGE_KEY, text)
  void saveValue(STORAGE_KEY_2, text2)
}

// ---------------------------------------------------------------------------
// グラスへの反映
// ---------------------------------------------------------------------------

/** いまグラスに出すページの本文 */
function pageBody(): string {
  return pageMode && page === 2 ? text2 : text
}

/**
 * グラスに実際に出す文字列（グラス・プレビュー共通）。
 * 2ページモードでは本文の下に「[1/2]」を付ける。
 * 空文字は避け、非表示・空本文のときは半角スペース1つにする。
 */
function glassContent(): string {
  if (hidden) return ' '
  const footer = pageMode && SHOW_PAGE_NUMBER ? `\n[${page}/${PAGE_COUNT}]` : ''
  const body = pageBody().slice(0, MAX_CHARS - footer.length)
  const content = body + footer
  return content.length > 0 ? content : ' '
}

/** 送信は直列化し、実行時点の最新状態（text / page / hidden）を送る */
function pushToGlasses(): void {
  if (!bridge || !glassesReady) return
  const b = bridge
  sendQueue = sendQueue.then(async () => {
    const content = glassContent()
    try {
      const ok = await b.textContainerUpgrade(
        new TextContainerUpgrade({
          containerID: CONTAINER_ID,
          containerName: CONTAINER_NAME,
          content,
        }),
      )
      if (!ok) console.warn('textContainerUpgrade returned false')
    } catch (e) {
      console.error('textContainerUpgrade failed', e)
    }
  })
}

/** 保存は常に、グラスへの送信は「いま出しているページ」が編集されたときだけ行う */
function scheduleSync(affectsGlasses: boolean): void {
  if (affectsGlasses) syncNeedsPush = true
  window.clearTimeout(syncTimer)
  syncTimer = window.setTimeout(() => {
    saveAllText()
    if (syncNeedsPush) {
      syncNeedsPush = false
      pushToGlasses()
    }
  }, SYNC_DEBOUNCE_MS)
}

function setHidden(next: boolean): void {
  hidden = next
  renderUi()
  pushToGlasses()
}

/** 2ページモードの切替。切り替えたら必ずページ1から始める */
function setPageMode(next: boolean): void {
  pageMode = next
  page = 1
  renderUi()
  void saveValue(STORAGE_KEY_MODE, next ? '1' : '0')
  pushToGlasses()
}

/** ページ1 ⇄ ページ2 を切り替える（2ページモード中のみ） */
function flipPage(): void {
  if (!pageMode) return
  page = page === 1 ? 2 : 1
  renderUi()
  pushToGlasses()
}

/** グラス上のスライドから呼ばれる。非表示中は無視し、短時間の重複も抑える */
function flipPageFromGlasses(): void {
  if (!pageMode || hidden) return
  const now = Date.now()
  if (now - lastFlipAt < FLIP_GUARD_MS) return
  lastFlipAt = now
  flipPage()
}

/** 長押し・メニュー・スマホのボタンの3経路から呼ばれる。二重発火を抑える */
function toggleHidden(): void {
  const now = Date.now()
  if (now - lastToggleAt < TOGGLE_GUARD_MS) return
  lastToggleAt = now
  setHidden(!hidden)
}

// ---------------------------------------------------------------------------
// スマホ側UI
// ---------------------------------------------------------------------------

/** which: 編集されたページ（1 = editor, 2 = editor2） */
function onEdit(which: PageNo): void {
  if (which === 1) text = editor.value
  else text2 = editor2.value
  renderUi()
  // 2ページモードでなければページ2は表示されない。グラスに出ているページの編集だけ送る
  scheduleSync(which === 1 ? !(pageMode && page === 2) : pageMode && page === 2)
}

function insertAtCursor(target: HTMLTextAreaElement, snippet: string): void {
  const start = target.selectionStart ?? target.value.length
  const end = target.selectionEnd ?? target.value.length
  target.setRangeText(snippet, start, end, 'end')
  target.focus()
  onEdit(target === editor2 ? 2 : 1)
}

function bindUi(): void {
  el<HTMLElement>('ver').textContent = `v${__APP_VERSION__}`
  editor.maxLength = MAX_CHARS
  editor2.maxLength = MAX_CHARS
  editor.addEventListener('input', () => onEdit(1))
  editor2.addEventListener('input', () => onEdit(2))

  pageModeInput.addEventListener('change', () => setPageMode(pageModeInput.checked))
  flipBtn.addEventListener('click', flipPage)

  toggleBtn.addEventListener('click', () => {
    // ボタン操作は即時反映（ガード対象外）
    lastToggleAt = Date.now()
    setHidden(!hidden)
  })

  connectBtn.addEventListener('click', () => {
    void connectToGlasses()
  })

  // 記号ボタン。data-target で指した入力欄（ページ1/ページ2）に挿入する
  document.querySelectorAll<HTMLDivElement>('.chips').forEach((bar) => {
    bar.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-ins]')
      if (!btn) return
      insertAtCursor(bar.dataset.target === 'editor2' ? editor2 : editor, btn.dataset.ins ?? '')
    })
  })
}

// ---------------------------------------------------------------------------
// グラス接続
// ---------------------------------------------------------------------------

async function connectBridge(): Promise<EvenAppBridge | null> {
  try {
    return await Promise.race([
      waitForEvenAppBridge(),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), BRIDGE_TIMEOUT_MS)),
    ])
  } catch {
    return null
  }
}

/** グラスに出す全画面テキスト（起動・再構築で共通） */
function buildTextObject(): TextContainerProperty[] {
  return [
    new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: 576,
      height: 288,
      borderWidth: 0,
      borderColor: 5,
      paddingLength: 8,
      containerID: CONTAINER_ID,
      containerName: CONTAINER_NAME,
      content: glassContent(),
      isEventCapture: 1, // 入力（長押し・スライド等）を受け取る
    }),
  ]
}

/** 長押しがOSメニューに取られる場合の保険。メニューから「隠す/出す」を選べる */
function buildMenu(): MenuContainerProperty {
  return new MenuContainerProperty({
    menuItems: [new MenuItemProperty({ itemName: MENU_TOGGLE_LABEL, itemID: MENU_TOGGLE_ID })],
  })
}

interface OpenResult {
  ok: boolean
  /** 画面に出す補足（成功時はメニュー無しの場合のみ、失敗時は各段階の結果） */
  detail: string
}

/**
 * 画面を開く。createStartUpPageContainer は「起動時に1回だけ」の決まりで、
 * すでにページがある状態（再起動・再読み込みなど）だとコード1(invalid)で拒否されることがある。
 * そのため 1) 新規作成 → 2) 再構築 → 3) メニュー無しで再構築 の順に試す。
 */
async function openPage(b: EvenAppBridge): Promise<OpenResult> {
  const tried: string[] = []

  // 1) 通常の新規作成
  try {
    const r = await b.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: 1,
        textObject: buildTextObject(),
        menuObject: buildMenu(),
      }),
    )
    if (r === StartUpPageCreateResult.success) return { ok: true, detail: '' }
    console.warn('createStartUpPageContainer failed:', r)
    tried.push(`作成:${r}`)
  } catch (e) {
    console.error('createStartUpPageContainer threw', e)
    tried.push('作成:例外')
  }

  // 2) 既存ページを作り直す（メニューも付ける）
  try {
    const ok = await b.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: 1,
        textObject: buildTextObject(),
        menuObject: buildMenu(),
      }),
    )
    if (ok) return { ok: true, detail: '' }
    tried.push('再構築:失敗')
  } catch (e) {
    console.error('rebuildPageContainer threw', e)
    tried.push('再構築:例外')
  }

  // 3) メニューが原因の場合に備え、メニュー無しで作り直す（長押しとスマホのボタンは使える）
  try {
    const ok = await b.rebuildPageContainer(
      new RebuildPageContainer({ containerTotalNum: 1, textObject: buildTextObject() }),
    )
    if (ok) return { ok: true, detail: '（メニュー無し）' }
    tried.push('メニュー無し:失敗')
  } catch (e) {
    console.error('rebuildPageContainer (no menu) threw', e)
    tried.push('メニュー無し:例外')
  }

  return { ok: false, detail: `（${tried.join(' / ')}）` }
}

async function startGlasses(b: EvenAppBridge): Promise<void> {
  const result = await openPage(b)
  linkDetail = result.detail

  if (!result.ok) {
    link = 'error'
    renderUi()
    return
  }

  glassesReady = true
  link = 'glasses'
  renderUi()
  listenGlassesInput(b)
  // 起動時点の最新テキストを念のため反映（起動中に編集された場合に備える）
  pushToGlasses()
}

function listenGlassesInput(b: EvenAppBridge): void {
  b.onEvenHubEvent((event) => {
    // 1) コンテキストメニューの「隠す/出す」
    if (event.menuItemClickEvent?.itemID === MENU_TOGGLE_ID) {
      toggleHidden()
      return
    }

    // 2) 長押し（開始時に切替。リリースイベントは使わない）
    if (event.sysEvent?.eventType === OsEventTypeList.LONG_PRESS_EVENT) {
      toggleHidden()
      return
    }

    // 3) テンプル / R1リングのスライド（上下どちらでも）= ページ1 ⇄ ページ2（2ページモードのみ）
    const swipe = event.textEvent?.eventType ?? event.sysEvent?.eventType
    if (pageMode && swipe !== undefined && SWIPE_EVENT_TYPES.has(swipe)) {
      flipPageFromGlasses()
      return
    }

    // 4) ダブルタップ = アプリ終了（ルートページの必須仕様。確認ダイアログ付き）
    if (event.textEvent?.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      void b.shutDownPageContainer(1)
    }
  })
}

// ---------------------------------------------------------------------------
// 起動
// ---------------------------------------------------------------------------

/**
 * グラスへの表示を開始する。起動時に自動で1回、失敗したらボタンから何度でもやり直せる。
 * 接続済みなら何もしない（入力リスナーを二重登録しないため）。
 */
async function connectToGlasses(): Promise<void> {
  if (connecting || glassesReady) return
  connecting = true
  link = 'connecting'
  linkDetail = ''
  renderUi()
  try {
    if (!bridge) bridge = await connectBridge()
    if (!bridge) {
      link = 'preview'
      return
    }
    await startGlasses(bridge)
  } finally {
    connecting = false
    renderUi()
  }
}

async function main(): Promise<void> {
  bindUi()
  editor.value = text
  renderUi()

  bridge = await connectBridge()
  text = (await loadValue(STORAGE_KEY)) || DEFAULT_TEXT
  text2 = (await loadValue(STORAGE_KEY_2)) || DEFAULT_TEXT2
  pageMode = (await loadValue(STORAGE_KEY_MODE)) === '1'
  page = 1
  editor.value = text
  editor2.value = text2
  renderUi()

  await connectToGlasses()
}

void main()
