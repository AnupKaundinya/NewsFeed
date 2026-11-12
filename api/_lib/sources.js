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
// Fierce and SDxCentral 403 their RSS to any non-browser fetch, so they're read
// through a site-restricted Google News search instead, keeping their own tier.
const FIERCE = { url: gnews("site:fierce-network.com when:21d"), tier: 1, kind: "press" };
const DCK = { url: "https://www.datacenterknowledge.com/rss.xml", tier: 1, kind: "press" };
const NETWORLD = { url: "https://www.networkworld.com/feed/", tier: 1, kind: "press" };

const REGISTER = { url: "https://www.theregister.com/headlines.atom", tier: 2, kind: "press" };
// Most of SDxCentral's indexed URLs are tag/author/event pages ("News - Bob Victor",
// "HPE Networking Investor Day 2026"); real headlines run longer, so require 6+ words.
const SDX = { url: gnews("site:sdxcentral.com when:21d"), tier: 2, kind: "press", minWords: 6 };
const LIGHTREADING = { url: "https://www.lightreading.com/rss.xml", tier: 2, kind: "press" };
const NEXTPLATFORM = { url: "https://www.nextplatform.com/feed/", tier: 2, kind: "press" };
const BLOCKSFILES = { url: "https://blocksandfiles.com/feed/", tier: 2, kind: "press" };
const STH = { url: "https://www.servethehome.com/feed/", tier: 2, kind: "press" };

// --- Vendor blogs ----------------------------------------------------------
// Removed: HPE community, Cisco newsroom, Broadcom (404); Juniper, Marvell, AMD
// (403, bot-blocked at the edge — no URL will work). Vendor news still reaches
// these beats through the per-beat Google News query, which indexes their newsrooms.
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
// General company blog, not networking-specific — relies on keywords + the
// LLM's relevance gate to surface only the infra/networking posts (e.g. the
// MRC supercomputer piece) out of everything else OpenAI publishes.
const OPENAI_BLOG = { url: "https://openai.com/news/rss.xml", tier: 1, kind: "press" };

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
  // shopping posts only — a bare "deal" is usually a contract or acquisition here
  /\b(deals? of the (day|week)|best deals?|discount|coupon|promo code|black friday|cyber monday)\b/i,
  /\b(quiz|horoscope|listicle)\b/i,
  /^\s*(watch|listen|podcast|episode\s+\d+)\b/i,
  /^\s*(news|analysis|editors' views|opinion|topics?)\s+-\s+/i,   // section/tag landing pages
];

// Off-topic descriptions shared by every beat. A candidate closer to one of
// these than to its beat's profile is dropped (see api/_lib/relevance.js).
export const ANTI_PROFILE = [
  "Enterprise campus and branch office networking: Wi-Fi access points, wireless LAN, campus switches, SD-WAN, SASE and retail store networks.",
  "Cybersecurity products, threat research, firewalls, zero trust and security operations, not about data center infrastructure.",
  "Collaboration, video conferencing, contact center software, observability dashboards and IT management software.",
  "Vendor events, keynotes, webinars, certifications, training courses, partner programs and customer awards.",
  "Telecom carriers, 5G and mobile networks, consumer broadband, smartphones and consumer technology.",
  "Stock market commentary, share price moves, analyst ratings and investment advice.",
  "AI models, chatbots, AI apps and software features with no data center or infrastructure angle.",
];

// Keywords match whole words (plurals included). A trailing "*" matches a prefix.
// Each beat's `profile` is what the embedding comparison measures closeness to:
// write it like the ideal story for that beat.
export const BUCKETS = [
  {
    id: "hpe",
    label: "HPE Networking (Juniper + Aruba)",
    keywords: ["hpe", "hewlett packard", "juniper", "aruba", "mist ai", "apstra"],
    profile: "HPE and Juniper Networks data center networking: data center switches and routers, AI data center fabrics, Apstra automation, QFX and PTX platforms, 800G Ethernet for AI clusters, HPE's Juniper integration and networking strategy for cloud and AI infrastructure.",
    query: "HPE Networking OR Juniper Networks OR Aruba data center switching",
    feeds: [DCD, FIERCE, DCK, NETWORLD, REGISTER, LIGHTREADING, SDX],
  },
  {
    id: "cisco",
    label: "Cisco",
    // No "catalyst": that's Cisco's campus line, and it pulled in office/branch stories.
    keywords: ["cisco", "nexus", "silicon one", "hypershield", "aci"],
    profile: "Cisco data center networking: Nexus switches, Silicon One chips, AI networking fabrics for GPU clusters, Nexus Dashboard and ACI, high-speed optics, Cisco deals with hyperscalers, neoclouds and NVIDIA for AI infrastructure.",
    query: "Cisco data center networking switching",
    feeds: [DCD, FIERCE, DCK, NETWORLD, CISCO_BLOG, REGISTER, LIGHTREADING],
  },
  {
    id: "arista",
    label: "Arista",
    keywords: ["arista", "eos", "cloudvision", "etherlink"],
    profile: "Arista Networks data center and AI networking: Etherlink AI switches, 800G and 1.6T spine and leaf platforms, EOS, AI cluster back-end and front-end networks, cloud titan customers, earnings and market share in data center switching.",
    query: "Arista Networks data center switching",
    feeds: [DCD, FIERCE, DCK, NETWORLD, ARISTA, REGISTER, NEXTPLATFORM],
  },
  {
    id: "silicon",
    label: "Silicon & Industry Trends",
    keywords: [
      "broadcom", "tomahawk", "jericho", "trident", "nvidia", "mellanox", "spectrum-x",
      "silicon one", "marvell", "asic", "switch chip", "optics", "co-packaged", "serdes",
      "800g", "1.6t", "amd", "pensando", "helios", "rack-scale", "rackscale",
    ],
    // AMD's own blog is bot-blocked (see note above), so its launches — e.g.
    // Helios — depend on this query and trade-press pickup to surface at all.
    query: "Broadcom Tomahawk OR Nvidia Spectrum OR AMD Helios OR networking silicon OR co-packaged optics",
    profile: "Networking and data center silicon: switch ASICs like Broadcom Tomahawk and Jericho, NVIDIA Spectrum-X and InfiniBand switches, SmartNICs and DPUs, SerDes, co-packaged and pluggable optics, 800G and 1.6T, rack-scale AI systems such as NVL72 and AMD Helios.",
    feeds: [NVIDIA, STH, DCD, NEXTPLATFORM, REGISTER, DCK, BLOCKSFILES],
  },
  {
    id: "ai_industry",
    label: "AI Infrastructure, Neoclouds & Data Center Builds",
    profile: "AI data center buildout: hyperscaler and neocloud GPU clusters and capex, CoreWeave, Crusoe, Lambda, Nebius and Vultr capacity and funding, new data center campuses measured in megawatts and gigawatts, power and grid deals, liquid cooling, colocation from Equinix and Digital Realty.",
    keywords: [
      "hyperscaler", "ai data center", "ai infrastructure", "gpu cluster",
      "training cluster", "inference cluster", "ai supercomputer",
      "supercomputer networking", "data center power", "power grid capacity",
      "data center cooling", "liquid cooling", "megawatt", "gigawatt", "data center build*",
      "data center capex", "data center campus", "colocation",
      // Neoclouds / GPU clouds and colo operators. "lambda" also matches AWS
      // Lambda; the LLM's scope check drops those.
      "neocloud", "gpu cloud", "coreweave", "crusoe", "vultr", "lambda", "nebius",
      "nscale", "together ai", "fluidstack", "applied digital", "equinix", "digital realty",
    ],
    query: [
      "AI data center hyperscaler capex power grid infrastructure",
      "CoreWeave OR Crusoe OR Vultr OR Nebius OR Lambda OR Nscale OR Fluidstack data center GPU cloud",
    ],
    feeds: [DCD, FIERCE, DCK, NETWORLD, META_ENG, AWS_NET, GCP, AZURE, CLOUDFLARE, NEXTPLATFORM, REGISTER, OPENAI_BLOG],
  },
  {
    id: "space",
    label: "Space Data Centers",
    keywords: ["orbital", "space data cent*", "satellite", "starcloud", "in-orbit", "leo"],
    query: "orbital space data center satellite compute",
    profile: "Data centers in space: orbital and in-orbit compute, satellites carrying GPUs or servers, startups like Starcloud building space-based data centers, launch plans, power and cooling for compute in orbit, lunar data storage.",
    feeds: [DCD, DCK, REGISTER],
  },
  {
    id: "standards",
    label: "Networking Standards & Innovations",
    keywords: [
      "rdma", "roce", "ultra ethernet", "uec", "infiniband", "nvlink", "ualink",
      "cxl", "ietf", "ieee 802", "consortium", "protocol", "congestion control",
      "load balanc*", "topology",
      // OpenAI's Multipath Reliable Connection transport for its supercomputer fabric.
      "multipath reliable connection", "mrc", "multipath transport",
    ],
    profile: "Data center and AI networking standards and transports: RDMA and RoCE, Ultra Ethernet Consortium, InfiniBand, NVLink and UALink, Multipath Reliable Connection (MRC), congestion control, load balancing and topology for GPU clusters, IEEE 802.3 and OCP specifications.",
    query: [
      "RDMA OR RoCE OR Ultra Ethernet Consortium OR InfiniBand OR NVLink standards",
      '"Multipath Reliable Connection" OR "MRC protocol" OR "multipath transport" AI networking',
    ],
    feeds: [META_ENG, AWS_NET, NETFLIX_ENG, OCP, ETHERNET_ALLIANCE, DCD, NETWORLD, NEXTPLATFORM, STH, OPENAI_BLOG],
  },
];

export const TAGS = [
  "Product Launch", "Earnings", "Partnership", "AI Fabric",
  "Executive Move", "Industry Standard", "Other",
];
