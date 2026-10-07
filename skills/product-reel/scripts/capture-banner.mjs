// Cookie / consent banner dismissal for capture.mjs --dismiss-banners.
// A button counts only when its whole label is a known consent phrase in English, Korean, Japanese, Chinese, German,
// French or Spanish. "Strong" phrases (accept, agree, allow) may sit anywhere; "weak" ones (ok, got it, close) are
// generic words that also label ordinary form buttons, so they count only inside an overlay (fixed or sticky box,
// dialog, or a container named cookie, consent, banner, modal ...).
// states.mjs imports dismissBanner from here, so capture.mjs --dismiss-banners and the states script click the same labels.

export const CONSENT_STRONG = "accept|accept all|accept all cookies|accept cookies|accept the cookies|accept and close|accept and continue|accept and proceed|accept & close|accept & continue|agree|i agree|i accept|yes i agree|yes i accept|agree and close|agree and continue|agree and proceed|agree & close|agree & continue|allow|allow all|allow all cookies|allow cookies|allow and continue|consent|동의|모두 동의|전체 동의|모두 동의하기|동의합니다|동의하고 계속|동의하고 계속하기|동의 후 계속|수락|모두 수락|전체 수락|수락하기|수락합니다|허용|모두 허용|전체 허용|쿠키 허용|모든 쿠키 허용|쿠키 모두 허용|모든 쿠키 수락|同意する|同意します|同意|すべて同意|全て同意|すべて同意する|承諾|承諾する|承認|許可|許可する|すべて許可|すべて許可する|すべてのcookieを許可|受け入れる|すべて受け入れる|すべてを受け入れる|Cookieを受け入れる|接受|接受全部|全部接受|接受所有|接受所有cookie|接受全部cookie|我同意|同意并继续|同意並繼續|我接受|允许|允許|全部允许|全部允許|允许所有|允許全部|akzeptieren|alle akzeptieren|alles akzeptieren|alle cookies akzeptieren|cookies akzeptieren|akzeptieren und schließen|akzeptieren und weiter|ich akzeptiere|zustimmen|ich stimme zu|einverstanden|annehmen|alle annehmen|zulassen|alle zulassen|alle cookies zulassen|accepter|tout accepter|accepter tout|accepter tous les cookies|accepter les cookies|accepter et fermer|accepter et continuer|j'accepte|je suis d'accord|d'accord|autoriser|tout autoriser|autoriser tout|autoriser les cookies|aceptar|aceptar todo|aceptar todas|aceptar todas las cookies|aceptar cookies|aceptar y cerrar|aceptar y continuar|acepto|estoy de acuerdo|de acuerdo|permitir|permitir todo|permitir todas|permitir todas las cookies|permitir cookies|consentir".split('|');

export const CONSENT_WEAK = "ok|okay|got it|i understand|understood|close|dismiss|확인|확인했습니다|알겠습니다|닫기|閉じる|了解|了解しました|わかりました|确定|確定|确认|確認|好的|知道了|我知道了|关闭|關閉|verstanden|alles klar|schließen|schliessen|compris|j'ai compris|entendu|fermer|entendido|vale|cerrar".split('|');

/** Comparison form of a label: NFKC, lower case, "&" as "and", curly apostrophes flattened, everything but letters, digits and ' dropped (so spaces, punctuation and emoji do not matter). */
export const compactLabel = (s) => String(s).normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/[‘’ʼ`´]/g, "'").replace(/[^\p{L}\p{M}\p{N}']+/gu, '');

const STRONG = new Set(CONSENT_STRONG.map(compactLabel));
const WEAK = new Set(CONSENT_WEAK.map(compactLabel));

/** 'strong' | 'weak' | null for a button label. */
export function consentKind(label) {
  const c = compactLabel(label);
  if (!c || c.length > 48) return null;
  return STRONG.has(c) ? 'strong' : WEAK.has(c) ? 'weak' : null;
}

/**
 * Clicks the most likely consent button, or reports that none matched.
 * @returns {Promise<{ clicked: string | null, checked: number, error?: string }>}
 */
export async function dismissBanner(page) {
  try {
    return await page.evaluate(({ strong, weak }) => {
      // Same normalisation as compactLabel() above: this function runs inside the page and cannot reach Node's copy.
      const compact = (s) => String(s).normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/[‘’ʼ`´]/g, "'").replace(/[^\p{L}\p{M}\p{N}']+/gu, '');
      const inOverlay = (el) => {
        for (let e = el, depth = 0; e && e !== document.body && depth < 8; e = e.parentElement, depth++) {
          const position = getComputedStyle(e).position;
          if (position === 'fixed' || position === 'sticky') return true;
          if (e.localName === 'dialog' || e.getAttribute('aria-modal') === 'true' || /^(alert)?dialog$/.test(e.getAttribute('role') || '')) return true;
          if (/cookie|consent|gdpr|privacy|banner|notice|popup|modal|overlay|cmp|onetrust|didomi|cookiebot|usercentrics|cc-window/i.test(`${e.id} ${typeof e.className === 'string' ? e.className : ''}`)) return true;
        }
        return false;
      };
      const strongSet = new Set(strong);
      const weakSet = new Set(weak);
      const items = [...document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]')]
        .filter((el) => el.getClientRects().length)
        .map((el) => {
          const label = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
          const c = compact(label);
          return { el, label, kind: c && c.length <= 48 ? (strongSet.has(c) ? 'strong' : weakSet.has(c) ? 'weak' : null) : null };
        });
      const hits = items.filter((x) => x.kind).map((x) => ({ ...x, overlay: inOverlay(x.el) }));
      const pick = hits.find((x) => x.kind === 'strong' && x.overlay) || hits.find((x) => x.kind === 'strong') || hits.find((x) => x.kind === 'weak' && x.overlay);
      if (!pick) return { clicked: null, checked: items.length };
      pick.el.click();
      return { clicked: pick.label, checked: items.length };
    }, { strong: [...STRONG], weak: [...WEAK] });
  } catch (err) {
    return { clicked: null, checked: 0, error: String(err.message).split('\n')[0] };
  }
}

/** The note capture.mjs records for one viewport. */
export function bannerNote(vpName, r) {
  if (r.clicked) return `${vpName}: clicked cookie banner button "${r.clicked}"`;
  if (r.error) return `${vpName}: dismiss-banners: the check failed (${r.error})`;
  return `${vpName}: dismiss-banners: no banner matched (${r.checked} visible buttons and links checked for accept, agree, allow or OK labels in English, Korean, Japanese, Chinese, German, French and Spanish). If a banner is still in the screenshots, click it with states.mjs (--click=<selector>) or send screenshots.`;
}
