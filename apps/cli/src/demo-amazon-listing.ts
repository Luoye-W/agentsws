/**
 * WP396（docs/106 §13）：demo 里的 **Listing 体检替身读页**——不连 Amazon，三个演示 ASIN 各回一页照 Amazon
 * 商品页结构写的 HTML（标题里有促销字眼、图少、没 A+；一款没货；一款正常）。读页积木本身是 WP394 的；
 * demo 这里只演「读到了之后怎么判」。ASIN 是编的（`B0DEMO…`），不是任何真实商品。
 */
import type { AmazonListingReader } from '@agentsws/server'

export const DEMO_OWN_ASINS = [
  { marketplace: 'US', asin: 'B0DEMOEB01', label: 'Explorer 1000 v2' },
  { marketplace: 'US', asin: 'B0DEMOEB02', label: 'Solar Panel 100W' },
  { marketplace: 'US', asin: 'B0DEMOEB03', label: 'Explorer 300' },
] as const

interface Page {
  title: string
  bullets: string[]
  images: number
  video: boolean
  aplus: boolean
  description: boolean
  price: string
  stock: boolean
  rating: string
  reviews: string
}

const PAGES: Record<string, Page> = {
  B0DEMOEB01: {
    title:
      'Nordvolt Explorer 1000 v2 Portable Power Station, Best Solar Generator for Camping, 1070Wh LiFePO4 Battery, Power Station Power Station for Home Backup!!',
    bullets: [
      '1070Wh LiFePO4 battery lasts 3,000 cycles to 80% capacity',
      'Charges from 0 to 80% in 1.7 hours from a wall outlet',
      '',
    ],
    images: 3,
    video: false,
    aplus: false,
    description: true,
    price: '$799.00',
    stock: true,
    rating: '4.6 out of 5 stars',
    reviews: '1,284 ratings',
  },
  B0DEMOEB02: {
    title: 'Nordvolt Solar Panel 100W Foldable for Portable Power Station, IP67',
    bullets: [
      '23.4% efficient monocrystalline cells',
      'Folds to the size of a laptop bag',
      'IP67 waterproof junction box',
    ],
    images: 7,
    video: true,
    aplus: true,
    description: true,
    price: '$229.00',
    stock: false,
    rating: '4.4 out of 5 stars',
    reviews: '312 ratings',
  },
  B0DEMOEB03: {
    title: 'Nordvolt Explorer 300 Portable Power Station, 293Wh, 300W AC Outlet',
    bullets: [
      '293Wh battery for phones, laptops and a mini fridge',
      'Weighs 7.1 lb with a fold-down handle',
      'Pure sine wave AC output',
    ],
    images: 7,
    video: true,
    aplus: true,
    description: true,
    price: '$249.00',
    stock: true,
    rating: '4.7 out of 5 stars',
    reviews: '5,120 ratings',
  },
}

function html(p: Page): string {
  const variants = Array.from({ length: p.images }, (_, i) =>
    JSON.stringify({ variant: i === 0 ? 'MAIN' : `PT0${i}` }),
  ).join(',')
  return `<!doctype html><html><body>
<script>var data = { 'colorImages': { 'initial': [${variants}]}, ${p.video ? '"videos":[{"title":"demo"}],' : '"videos":[],'} 'x': 1 };</script>
<span id="productTitle">${p.title}</span>
<a id="bylineInfo">Visit the Nordvolt Store</a>
<span id="acrPopover" title="${p.rating}"></span>
<span id="acrCustomerReviewText">${p.reviews}</span>
<div id="corePriceDisplay_desktop_feature_div"><span class="a-price"><span class="a-offscreen">${p.price}</span></span></div>
<div id="feature-bullets"><ul>${p.bullets.map((b) => `<li><span class="a-list-item">${b}</span></li>`).join('')}</ul></div>
<div id="availability"><span>${p.stock ? 'In Stock' : 'Currently unavailable.'}</span></div>
${p.stock ? '<input id="add-to-cart-button"><div id="merchantInfoFeature_feature_div"><span class="offer-display-feature-text-message">Nordvolt</span></div>' : ''}
<div id="productDescription">${p.description ? '<p>Power for camping and home backup.</p>' : ''}</div>
${p.aplus ? '<div id="aplus"><div class="aplus-v2"><div class="aplus-module">Story</div></div></div>' : ''}
</body></html>`
}

export function demoListingReader(): AmazonListingReader {
  return {
    async readProduct({ marketplace, asin }) {
      const url = `https://www.amazon.com/dp/${asin}`
      const page = PAGES[asin]
      if (marketplace !== 'US' || page === undefined)
        return { status: 'failed', url, message: 'demo 里没有这一页' }
      return { status: 'ok', url, html: html(page) }
    },
  }
}
