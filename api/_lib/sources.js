// ===========================================================================
// Source registry.
//
// tier 1 = trade press / vendors / engineering blogs you rated
// tier 2 = solid but unpicked trade press — pulled, but never outranks tier 1
// tier 3 = Google News catch-all so a story in an unlisted outlet still shows
//
// kind "blog" sets is_blog = true on the story (the labelled fallback).
// Vendor and engineering blogs are marked "press": for this beat they are
// primary sources, not filler.
//
// If a feed 404s or returns nothing, it shows up in the refresh response's
// `feed_health` array. Swap the URL and redeploy — nothing else to change.
// ===========================================================================

export function gnews(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

// --- Trade press -----------------------------------------------------------
const DCD = { url: "https://www.datacenterdynamics.com/en/rss/", tier: 1, kind: "press" };
const FIERCE = { url: "https://www.fierce-network.com/rss.xml", tier: 1, kind: "press" };
const DCK = { url: "https://www.datacenterknowledge.com/rss.xml", tier: 1, kind: "press" };
const NETWORLD = { url: "https://www.networkworld.com/feed/", tier: 1, kind: "press" };

const REGISTER = { url: "https://www.theregister.com/headlines.atom", tier: 2, kind: "press" };
const SDX = { url: "https://www.sdxcentral.com/feed/", tier: 2, kind: "press" };
const LIGHTREADING = { url: "https://www.lightreading.com/rss.xml", tier: 2, kind: "press" };
const NEXTPLATFORM = { url: "https://www.nextplatform.com/feed/", tier: 2, kind: "press" };
const BLOCKSFILES = { url: "https://blocksandfiles.com/feed/", tier: 2, kind: "press" };
const STH = { url: "https://www.servethehome.com/feed/", tier: 2, kind: "press" };

// --- Vendor blogs ----------------------------------------------------------
// Removed: HPE community, Cisco newsroom, Broadcom (404); Juniper, Marvell (403,
// bot-blocked at the edge — no URL will work). Vendor news still reaches these
// beats through the per-beat Google News query, which indexes their newsrooms.
const CISCO_BLOG = { url: "https://blogs.cisco.com/feed", tier: 1, kind: "press" };
const ARISTA = { url: "https://blogs.arista.com/blog/rss.xml", tier: 1, kind: "press" };
const NVIDIA = { url: "https://blogs.nvidia.com/feed/", tier: 1, kind: "press" };

// --- Hyperscaler / FAANG engineering blogs --------------------------------
const META_ENG = { url: "https://engineering.fb.com/feed/", tier: 1, kind: "press" };
const AWS_NET = { url: "https://aws.amazon.com/blogs/networking-and-content-delivery/feed/", tier: 1, kind: "press" };
const GCP = { url: "https://cloudblog.withgoogle.com/rss/", tier: 1, kind: "press" };
const AZURE = { url: "https://azure.microsoft.com/en-us/blog/feed/", tier: 1, kind: "press" };
const CLOUDFLARE = { url: "https://blog.cloudflare.com/rss/", tier: 1, kind: "press" };
const NETFLIX_ENG = { url: "https://netflixtechblog.com/feed", tier: 1, kind: "blog" };

// --- Standards bodies -----------------------------------------------------
const OCP = { url: "https://www.opencompute.org/blog/rss", tier: 1, kind: "press" };
const ETHERNET_ALLIANCE = { url: "https://ethernetalliance.org/feed/", tier: 2, kind: "blog" };

// Domains that are never worth reading here — dropped before anything else.
export const BLOCKED_DOMAINS = [
  "zacks.com", "fool.com", "investorplace.com", "benzinga.com", "simplywall.st",
  "marketbeat.com", "stocktwits.com", "tipranks.com", "insider monkey.com",
  "insidermonkey.com", "seekingalpha.com", "barchart.com", "gurufocus.com",
  "medium.com", "linkedin.com/pulse", "prnewswire.com", "globenewswire.com",
  "businesswire.com", "einpresswire.com", "openpr.com", "digitaljournal.com",
];

// Title shapes that are always noise, whatever the source.
export const REJECT_PATTERNS = [
  /\b(top|best|worst)\s+\d+\b/i,
  /\b\d+\s+(reasons|things|ways|stocks|picks|takeaways)\b/i,
  /\b(webinar|whitepaper|white paper|ebook|e-book)\b/i,
  /\b(sponsored|advertorial|partner content|promoted)\b/i,
  /\b(stock|shares|price target|buy rating|sell rating|analyst rating)\b/i,
  /\b(should you (buy|sell)|is it time to buy)\b/i,
  /\b(deals?|discount|coupon|black friday|cyber monday)\b/i,
  /\b(quiz|horoscope|listicle)\b/i,
  /^\s*(watch|listen|podcast|episode\s+\d+)\b/i,
];

export const BUCKETS = [
  {
    id: "hpe",
    label: "HPE Networking (Juniper + Aruba)",
    keywords: ["hpe", "hewlett packard", "juniper", "aruba", "mist ai", "apstra"],
    query: "HPE Networking OR Juniper Networks OR Aruba data center switching",
    feeds: [DCD, FIERCE, DCK, NETWORLD, REGISTER, LIGHTREADING, SDX],
  },
  {
    id: "cisco",
    label: "Cisco",
    keywords: ["cisco", "nexus", "silicon one", "hypershield", "aci", "catalyst"],
    query: "Cisco data center networking switching",
    feeds: [DCD, FIERCE, DCK, NETWORLD, CISCO_BLOG, REGISTER, LIGHTREADING],
  },
  {
    id: "arista",
    label: "Arista",
    keywords: ["arista", "eos", "cloudvision", "etherlink"],
    query: "Arista Networks data center switching",
    feeds: [DCD, FIERCE, DCK, NETWORLD, ARISTA, REGISTER, NEXTPLATFORM],
  },
  {
    id: "silicon",
    label: "Silicon & Industry Trends",
    keywords: [
      "broadcom", "tomahawk", "jericho", "trident", "nvidia", "mellanox", "spectrum-x",
      "silicon one", "marvell", "asic", "switch chip", "optics", "co-packaged", "serdes",
      "800g", "1.6t", "amd", "pensando",
    ],
    query: "Broadcom Tomahawk OR Nvidia Spectrum OR networking silicon OR co-packaged optics",
    feeds: [NVIDIA, STH, DCD, NEXTPLATFORM, REGISTER, DCK, BLOCKSFILES],
  },
  {
    id: "ai_industry",
    label: "AI Industry & Broader Trends",
    keywords: [
      "ai", "hyperscaler", "capex", "gpu", "cluster", "training", "inference",
      "power", "grid", "cooling", "megawatt", "data center build",
    ],
    query: "AI data center hyperscaler capex power grid infrastructure",
    feeds: [DCD, FIERCE, DCK, NETWORLD, META_ENG, AWS_NET, GCP, AZURE, CLOUDFLARE, NEXTPLATFORM, REGISTER],
  },
  {
    id: "space",
    label: "Space Data Centers",
    keywords: ["orbital", "space data cent", "satellite", "starcloud", "in-orbit", "leo"],
    query: "orbital space data center satellite compute",
    feeds: [DCD, DCK, REGISTER],
  },
  {
    id: "standards",
    label: "Networking Standards & Innovations",
    keywords: [
      "rdma", "roce", "ultra ethernet", "uec", "infiniband", "nvlink", "ualink",
      "cxl", "ietf", "ieee 802", "consortium", "protocol", "congestion control",
      "load balanc", "topology",
    ],
    query: "RDMA OR RoCE OR Ultra Ethernet Consortium OR InfiniBand OR NVLink standards",
    feeds: [META_ENG, AWS_NET, NETFLIX_ENG, OCP, ETHERNET_ALLIANCE, DCD, NETWORLD, NEXTPLATFORM, STH],
  },
];

export const TAGS = [
  "Product Launch", "Earnings", "Partnership", "AI Fabric",
  "Executive Move", "Industry Standard", "Other",
];
