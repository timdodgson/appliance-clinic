'use strict';
/**
 * Model-number hints (tool). Known UK model-series prefixes per brand suggest an appliance family. A hint is only
 * ever PROVISIONAL: it informs the reasoner and is never recorded as the customer's appliance or as a confirmed model.
 */

// brand -> [ [prefix regex (anchored), family] ]
const SERIES = {
  samsung: [[/^WW/, 'washing-machine'], [/^WF/, 'washing-machine'], [/^WD/, 'washer-dryer'], [/^DV/, 'tumble-dryer'], [/^R[BSFLHT]\d?/, 'fridge-freezer'], [/^DW/, 'dishwasher'], [/^M[SGCE]\d/, 'microwave'], [/^NV\d/, 'oven-cooker'], [/^NZ\d/, 'hobs'], [/^VS\d/, 'vacuum']],
  bosch: [[/^WA[NJUTWXVG]/, 'washing-machine'], [/^WG[AGB]/, 'washing-machine'], [/^WN[AG]/, 'washer-dryer'], [/^WK/, 'washer-dryer'], [/^WT[HNWGRX]/, 'tumble-dryer'], [/^WQ/, 'tumble-dryer'], [/^S[MPBRK][SVIDUE]/, 'dishwasher'], [/^K[GIAUF][NVLIE]/, 'fridge-freezer'], [/^H[BRMLSE][AGSFTRC]/, 'oven-cooker'], [/^P[IUXKVQ][EFJXS]/, 'hobs'], [/^(HMT|BFL|BEL|FFL|HMB|BFR)/, 'microwave'], [/^(BCH|BBS|BBH|BGL|BGS|BSG|BCS)/, 'vacuum']],
  siemens: [[/^W[MUGI]/, 'washing-machine'], [/^W[NDK]/, 'washer-dryer'], [/^W[TQ]/, 'tumble-dryer'], [/^S[NRXK]/, 'dishwasher'], [/^K[GIAF]/, 'fridge-freezer'], [/^H[BRMSE]/, 'oven-cooker'], [/^E[XHDT]/, 'hobs'], [/^(BF|BE|HF|CM)/, 'microwave']],
  neff: [[/^(W|V6)/, 'washing-machine'], [/^S[1-5]/, 'dishwasher'], [/^K[1-9]/, 'fridge-freezer'], [/^[BCU][1-9]/, 'oven-cooker'], [/^T[1-9]/, 'hobs'], [/^(H|N)[1-9]/, 'microwave']],
  hotpoint: [[/^(NSWM|NSWF|NSWA|RSG|RSSG|NM\d|NLCD|WMAQ|WMFUG|WMXTF|BIWMHG|H\d?W|H8W|NSWE)/, 'washing-machine'], [/^(NSWD|FDL|RD\d|BHWD|NDB|RDG|WDAL|WDPG|H\d?D|NDD)/, 'washer-dryer'], [/^(TVFM|TVHM|TCFS|NTM|NT\s?M|H2D|H3D|TDL|FETC|TCHL|NV4D|NTS)/, 'tumble-dryer'], [/^(HFC|HIC|HSIC|LTF|HEF|HSFE|HFO|LTB|HDC|H2F|H3B|HSFO)/, 'dishwasher'], [/^(FF|HM|H8|NMTP|HTC|RFAA|FFUL|H\d?T)/, 'fridge-freezer'], [/^(SA|SI|DD|SBS|HD|HC|HUE|HAE|HAGL)/, 'oven-cooker'], [/^(HAE|HR|CRA|CRM)/, 'hobs'], [/^(MWH|MP|MN)/, 'microwave']],
  indesit: [[/^(IWC|IWSC|IWDC|MTWA|BWE|XWE|BWA|BWC|IWA|EWC|EWD|IWSNC|MTWC|IWE)/, 'washing-machine'], [/^(IWDD|BDE|XWDE|EWDE|BWDD|IWDE)/, 'washer-dryer'], [/^(IDC|IDV|IDCE|YT|I2D|NIS|IS\d|YTM|IDCL|IDPE)/, 'tumble-dryer'], [/^(DFG|DSG|DIF|DIFP|DSR|DFP|DIO|DSFE|D2F)/, 'dishwasher'], [/^(IB|LR|IBD|I55|NCAA|IR)/, 'fridge-freezer'], [/^(IS|ID|IF|IFW|KDP|IT|IFWS)/, 'oven-cooker']],
  lg: [[/^F[0-9H][0-9A-Z]?/, 'washing-machine'], [/^FWV|^F4DV|^FWY/, 'washer-dryer'], [/^FDV|^RH\d|^FDR/, 'tumble-dryer'], [/^D[F]\d/, 'dishwasher'], [/^G[BSRCM][BLPFRX]/, 'fridge-freezer'], [/^M[SHJ]\d/, 'microwave']],
  beko: [[/^(WTK|WTL|WEC|WTB|WX|WTIK|WEX|WTG|WR|WMB|WM\d|WTV|BM3WT|B3W|B5W)/, 'washing-machine'], [/^(WDK|WDL|WDIK|WDX|WDEX|WDB|WDA|WDC|WDER|B3D|B5D)/, 'washer-dryer'], [/^(DTGC|DTLC|DCU|DTBP|DHX|DTGV|DCX|DHR|DPHR|DCR|DTBC|B3T|B5T)/, 'tumble-dryer'], [/^(DFN|DIN|DVN|DIS|DSN|DFS|DUT|DVS|DDN|BDF|BDIN)/, 'dishwasher'], [/^(CF|CS|CN|CR|CX|CFG|CCF|BC|TZ|FF|HA|CNG|CFP|BCFD)/, 'fridge-freezer'], [/^(BDF|BIF|BXIF|BRIF|KDC|KDG|KDVC|BDC|EDP|BDVC|BXIM|CSE|BBI|KTC|XTC)/, 'oven-cooker'], [/^(HI|HIC|HII|HIZG|HDMC|HIZE)/, 'hobs'], [/^(MOC|MGC|MOF|MCF|MXC)/, 'microwave'], [/^(VR|VRT|VCC|BVR|PowerClean)/, 'vacuum']],
  aeg: [[/^L[5-9]F/, 'washing-machine'], [/^L[6-9]W/, 'washer-dryer'], [/^L\d{5}/, 'washing-machine'], [/^T[5-9][DH]/, 'tumble-dryer'], [/^T\d{5}/, 'tumble-dryer'], [/^F[SFE][BSKE]/, 'dishwasher'], [/^(SCB|SCE|SCS|RCB|RCS|AGB|ABE|S7|S8|RCE|OSC|SKE)/, 'fridge-freezer'], [/^(BP|BE|BS|BC|BPS|BPK|BES|DCK|BCK|DEB|DEE)/, 'oven-cooker'], [/^(IK|IKB|IKE|HK|IAE|IPE|HKB)/, 'hobs'], [/^(MBB|MBE|MFC|KMK|KMF)/, 'microwave'], [/^(AP|QX|FX|CX|L8|AS)/, 'vacuum']],
  electrolux: [[/^EW[6-9]F/, 'washing-machine'], [/^EW[6-9]W/, 'washer-dryer'], [/^EW[6-9][CH]/, 'tumble-dryer'], [/^E[ES][FLSG]/, 'dishwasher']],
  zanussi: [[/^(ZWF|ZWN|ZWH|ZWD|ZWT|ZWG|ZWC)/, 'washing-machine'], [/^(ZWD|ZKG|ZWW)/, 'washer-dryer'], [/^(ZDC|ZDH|ZDP|ZTE|ZDE)/, 'tumble-dryer'], [/^(ZDF|ZDT|ZDLN|ZDS|ZDV)/, 'dishwasher'], [/^(ZNF|ZRB|ZNT|ZBB|ZFT|ZQF|ZNME)/, 'fridge-freezer'], [/^(ZOB|ZOP|ZCV|ZCG|ZCI|ZOD|ZOH|ZOC)/, 'oven-cooker'], [/^(ZIT|ZEI|ZGH|ZHRF|ZEV|ZIF|ZHRN)/, 'hobs']],
  miele: [[/^(WWD|WWG|WEG|WCD|WCI|WWE|WWH|WED|WKF|WKH|W1|WDB|WDD|WSD|W\s?\d{4})/, 'washing-machine'], [/^(WTD|WTH|WTF|WT1|WTR)/, 'washer-dryer'], [/^(TWD|TWF|TCF|TCE|TDB|TCJ|TED|TWB|TWC|T1|TKB|T\s?\d{4})/, 'tumble-dryer'], [/^(G\s?\d{4}|G\d)/, 'dishwasher'], [/^(KFN|KF|K\s?\d|FN|KD)/, 'fridge-freezer'], [/^(H\s?\d{4}|DGC|H2|H6|H7)/, 'oven-cooker'], [/^(KM\s?\d|CS)/, 'hobs'], [/^(M\s?\d{4}|M2|M6|M7)/, 'microwave'], [/^(S\d|C[1-3]|SGDA|SGEA|SGSK|SKRR|Triflex|Complete|Blizzard)/i, 'vacuum']],
  whirlpool: [[/^(FSCR|FFB|FWG|FWSG|FWDG|FFS|FFD|FFL|W6|W7|W8|TDLR|AWO|AWE|FSCM|BWE)/, 'washing-machine'], [/^(FWDD|FFWDB|FWDG|WWDC)/, 'washer-dryer'], [/^(FFT|HSCX|AZB|FT|ST|DDLX|W6 D|AWZ)/, 'tumble-dryer'], [/^(WFC|WFO|WIC|WIO|WRIC|WSFC|WBC|WFE|ADP|W2F|W7I)/, 'dishwasher'], [/^(W5|W7|W9|WTNF|BSNF|WQ9|WBA|WBC|WB)/, 'fridge-freezer'], [/^(MWP|MAX|JQ|JT|MCP|MWF|AMW|W6MW|MWO)/, 'microwave']],
  candy: [[/^(CS|GVS|CSO|RO|GC|CBW|CBWO|CVS|BWM|CO|HCS|CY|RP)/, 'washing-machine'], [/^(CSW|GVSW|CSOW|ROW|CBWD|CVSW|CDB|GVW)/, 'washer-dryer'], [/^(CS\s?C|CSC|GVS\s?C|GVC|CSO\s?H|CS4|CSV|CS\s?H|ROE|GCC)/, 'tumble-dryer'], [/^(CDP|CDI|CF|CDIH|CDPN|CDPM|CDPE)/, 'dishwasher']],
  hoover: [[/^(H-?WASH|HW|DXOA|DXO|DXOC|HWB|HBWM|HWP|DHL|WDXOA|HW4|DXOA)/, 'washing-machine'], [/^(H-?WASH&DRY|HWD|HDD|WDXOA|HD4|HBWD|DXW|WDQA|HDB)/, 'washer-dryer'], [/^(H-?DRY|HLE|HLC|DXC|NDE|HL|HDB|DX|VTC|VHC|HLV|NDP|NDPEH|ATDC|HLEC|HLEV|DMHD|HD)/, 'tumble-dryer'], [/^(HF|HDI|HDPN|HDYN|HEFS|HDP)/, 'dishwasher'], [/^(HF|H-?FREE|HL|HP|HU|TH|BR|HFE|TSH|CAH|HX|RA|ANE|HE)/, 'vacuum']],
  haier: [[/^(HW|I-?PRO|HWD)/, 'washing-machine'], [/^(HWD)/, 'washer-dryer'], [/^(HD|HDP)/, 'tumble-dryer'], [/^(HF|HB|HTF|HCE|HRF|A\d)/, 'fridge-freezer']],
  smeg: [[/^(WHT|LBW|WNP|WM3T)/, 'washing-machine'], [/^(DHT|DHT8)/, 'tumble-dryer'], [/^(DF|DI|ST|LSP|LVS|DFD)/, 'dishwasher'], [/^(FAB|FA|UKF|FC|FQ|RF|FD|SB)/, 'fridge-freezer'], [/^(SF|SFP|C9|TR|SUK|SY|CPF|SO|SFPA|TRA|A1|A2|A3|C6|C7|C9)/, 'oven-cooker'], [/^(SI|SE|PGF|PV|SR|PX|SIM|HOB)/, 'hobs']],
  panasonic: [[/^NN-?[A-Z]{1,2}\d/, 'microwave'], [/^NA-/, 'washing-machine']],
  sharp: [[/^R-?\d/, 'microwave'], [/^ES-/, 'washing-machine'], [/^SJ-/, 'fridge-freezer']],
  dyson: [[/^(V\d{1,2}|DC\d{2}|SV\d{2}|CY\d{2}|UP\d{2}|Gen5|Outsize|Cyclone|Omni)/i, 'vacuum']],
  shark: [[/^(NV|NZ|IZ|IX|HZ|AZ|CZ|WV|RV|AV|UV|LA|IF|HV|ICZ|CH)\d/, 'vacuum']],
  vax: [[/^(CLSV|ONEPWR|U8|UCA|CDCW|VX|UCSP|AWC|TBT|CVRAV|ECR|ECB)/i, 'vacuum']],
  henry: [[/^(HVR|HVX|HET|HXB|HHC|HEN)/i, 'vacuum']],
  numatic: [[/^(HVR|HVX|HET|HXB|HHC|HEN|JVP|NVR|NRV|PPR|HZQ)/i, 'vacuum']],
  gorenje: [[/^(W[A-Z]?\d|WE|WS|WNEI|WNHPI|WEI)/, 'washing-machine'], [/^(D[A-Z]?\d|DE|DS|DNE|DPNE)/, 'tumble-dryer'], [/^(GV|GS|GI)/, 'dishwasher'], [/^(NRK|RK|NRC|RB|NRS|FN|NRKI)/, 'fridge-freezer'], [/^(BO|BOP|BCM|BPS|K|EC|BOS|BSA|GEC|GI)/, 'oven-cooker'], [/^(IT|ECT|GW|GTW|IS|IQ|G6|ID|ECS)/, 'hobs']],
  'russell hobbs': [[/^RH/, 'microwave']],
  stoves: [[/^(ST|SEB|SGB|SEH|SDB|RICH|NEW|Richmond)/i, 'oven-cooker']],
  belling: [[/^(BI|FS|FSE|FSG|COOKCENTRE|Cookcentre|Farmhouse|DB|BEL|XOU|FSE)/i, 'oven-cooker']],
  leisure: [[/^(CK|CS|AL|CC|CUL|RD|GRB|GB)/, 'oven-cooker']],
  rangemaster: [[/^(CLA|CDL|ELA|PROP|TOLP|NEX|ELS|PDL|CLAS|KCH|PROFI|ELIS)/i, 'oven-cooker']],
};

const MODEL_RE = /\b([A-Z]{1,6}[- ]?\d{1,5}[A-Z0-9/-]{0,12}|\d{2,4}[A-Z]{1,5}\d{0,6}[A-Z0-9/-]{0,8})\b/;

/**
 * Hints for one model token. brand: lower-case brand if known.
 * Returns [{ brand, family, basis: 'series-prefix' }] — possibly several when the brand is unknown.
 */
function hints(token, brand = null) {
  const t = String(token || '').toUpperCase().replace(/\s+/g, '').replace(/^MODEL[:#]?/, '');
  if (t.length < 2) return [];
  const out = [];
  const brands = brand && SERIES[brand.toLowerCase()] ? [brand.toLowerCase()] : (brand ? [] : Object.keys(SERIES));
  for (const b of brands) {
    for (const [re, family] of SERIES[b]) {
      if (re.test(t)) { out.push({ brand: b, family, basis: 'series-prefix', provisional: true }); break; }
    }
  }
  return out.slice(0, 4);
}

/** Model-like tokens in free text (brand-agnostic shape check). Distinct from error codes; the reasoner decides. */
function candidateModels(text) {
  const out = [];
  const re = new RegExp(MODEL_RE.source, 'g');
  const s = String(text || '').toUpperCase();
  let m;
  while ((m = re.exec(s))) {
    const tok = m[1].replace(/\s+/g, '');
    // Plausible model numbers have at least 4 characters and both letters and digits; short tokens (E18, V6, 4C) are
    // passed to the reasoner as ambiguous rather than assumed to be models or codes.
    if (tok.length >= 4 && /[A-Z]/.test(tok) && /\d/.test(tok) && !out.includes(tok)) out.push(tok);
  }
  return out.slice(0, 5);
}

module.exports = { hints, candidateModels, SERIES };
