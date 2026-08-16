/* The internal links, harvested from sites.google.com/handpickedfurniture.com/links/home on
 * 9 Aug 2026 and grouped by what someone is actually trying to do.
 *
 * The Google Sites page is a flat list of ~32 items in no particular order; that is fine as a
 * bookmark dump but poor as a landing page, so the same links are grouped here by task.
 *
 * Seven labels on that page carry NO link (they are plain text, probably Drive embeds that never got
 * hyperlinked): Certificate of Completion, Installation SOP - Kurtains.pdf, Detailed SOP,
 * 20260403_Installation Prep and Checklist AT_v1.pdf, Materials List and SOP,
 * Semmer Villas Quote v1.pdf, Semmer Villas Curtains Quote. They are listed with url:null and render
 * greyed out, rather than being dropped silently - a missing link you can see is fixable.
 */

export const LINK_GROUPS = [
  {
    key: "grp.daily",
    icon: "📋",
    links: [
      { label: "3D Sheet — Dubai", url: "https://docs.google.com/spreadsheets/d/15hooqd0VNLtR4aEmifthbMEGmxtrrTbMxRjz00_iRkY/edit?gid=0#gid=0" },
      { label: "3D Sheet — Abu Dhabi + Order Form", url: "https://docs.google.com/spreadsheets/d/1rSQcWbA2wAHe0hLh9YQ4jBp7AKQK4cGEGSfrr23o-9E/edit?gid=884148743#gid=884148743" },
      { label: "Order Tracking — Dubai", url: "https://docs.google.com/spreadsheets/d/1YMsNRzzb8bsHIIYexsyrm5_SmrpDnk9Qp0siy36qZ5E/edit?usp=sharing" },
      { label: "Order Tracking — Abu Dhabi", url: "https://docs.google.com/spreadsheets/d/1qahUmS6JKSDYD659kgZefXTMsiduzUxsDBPsmU7waAc/edit?usp=sharing" },
      { label: "Looker report", url: "https://lookerstudio.google.com/u/0/reporting/8c08ec1d-9f0d-49b4-904c-b27829ab6611/page/p_ccj4ziy71d" },
    ],
  },
  {
    key: "grp.capture",
    icon: "📝",
    links: [
      { label: "Handpicked Order Capture Form", url: "https://docs.google.com/forms/d/e/1FAIpQLScPZ7iGEupJuiVKRUtqGd6Nz8MUxw8MldEo19F5rJGyF4YGpw/viewform?usp=dialog" },
      { label: "B2B Order Capture app", url: "https://handpickedfurniture.github.io/pfc-order-app/" },
      { label: "B2B price list", url: "https://claude.ai/code/artifact/7f573d63-85a7-427c-9737-bfd7b7bc4022" },
      { label: "Height Upload — Dubai", url: "https://script.google.com/macros/s/AKfycbxGgBPXYQue4zGmpLaKqh8svB1j7XjST-nIwIZ154SQmSTzvHQf64ChXpQbnV0polkP-w/exec" },
      { label: "Height Upload — Abu Dhabi", url: "https://script.google.com/macros/s/AKfycbzphlhxXJTyBWDqtOVsgVtU99EdxJpiBTHn865sqQcWFoswoUlrSdmUvpR6QvaB-A7Q4g/exec" },
      { label: "Regular Bills Upload", url: "https://forms.gle/gHp3fxU9uBDzbT2u7" },
      { label: "Warranty Bills", url: "https://forms.gle/Vjtgf2R2Ye8jGVYG6" },
    ],
  },
  {
    key: "grp.reference",
    icon: "📐",
    links: [
      { label: "Roll Width", url: "https://docs.google.com/spreadsheets/d/1cRM21nMCsOI_Ux3hcCcP-BL2g9GpxtqK/edit?usp=sharing&ouid=105868870517378875160&rtpof=true&sd=true" },
      { label: "Production formulas", url: "https://claude.ai/code/artifact/8c8bebc9-e3a0-4abc-b790-a5baf9cfff3d" },
      { label: "Desk Reference", url: "https://claude.ai/code/artifact/7930c8f8-3807-45ca-a812-c4fa26d12ed1?org=fe982ae2-5840-4145-b254-798d9ec39c77&open_in_browser=1" },
      { label: "Installation Coordinator SOP", url: "https://docs.google.com/document/d/1WTb6qphUABlCOPiXad5DaYKv3MUwyyiQ/edit?usp=sharing&ouid=105868870517378875160&rtpof=true&sd=true" },
      { label: "Velcro with stitching", url: "https://drive.google.com/file/d/1SsuutoAUQV-1dMllPz1ou45L7XngHtQt/view?usp=sharing" },
      { label: "Ready PDF Files", url: "https://drive.google.com/drive/folders/1_bOGkbCkxV8-HzJ3kyw4qIT9tLuOATG0?usp=drive_link" },
      { label: "Installation SOP (Kurtains).pdf", url: null },
      { label: "Detailed SOP", url: null },
      { label: "Installation Prep & Checklist v1.pdf", url: null },
      { label: "Materials List and SOP", url: null },
    ],
  },
  {
    key: "grp.training",
    icon: "🎓",
    links: [
      { label: "Interactive Coordinator Training", url: "https://claude.ai/code/artifact/a14aa193-a9d8-4606-aeab-4715eacf8bbf" },
      { label: "Questions & Answers", url: "https://claude.ai/code/artifact/4d070896-0f84-4f4d-8a01-22d40dc5c6a5?org=fe982ae2-5840-4145-b254-798d9ec39c77&open_in_browser=1" },
      { label: "Training video", url: "https://1drv.ms/v/c/0455a96efc9d7554/IQBegrgmDWHrRZofHN2jmZO2AeDuHFyp66baPLmBxO-odrE?e=msgXV7" },
    ],
  },
  {
    key: "grp.admin",
    icon: "🗂️",
    links: [
      { label: "Attendance Sheet", url: "https://docs.google.com/spreadsheets/d/1R9x_vdbWRLFsXdoja2cl4bG5vqCP7aHH/edit?usp=sharing&ouid=105868870517378875160&rtpof=true&sd=true" },
      { label: "Team Emirates IDs", url: "https://drive.google.com/drive/folders/1X1dkKbgyNUgKvGAwLH1-2srkgztFK6Xn?usp=sharing" },
      { label: "Adjustments format", url: "https://1drv.ms/x/c/0455a96efc9d7554/IQA_6X1o41G_RoEHnMrxlbauAWyMTQN4W1pbDiH3SOv-llM?e=GOrlnx" },
      { label: "Emaar Permits", url: "https://ecmpermits.ae/" },
      { label: "Certificate of Completion", url: null },
      { label: "Semmer Villas Quote v1.pdf", url: null },
      { label: "Semmer Villas Curtains Quote", url: null },
    ],
  },
];

/* The app's own modules, shown first - this is an operations app, not a bookmark page.
 *
 * EVERY module is here, including the seven in the ribbon. Home is the full index: the ribbon holds
 * the seven screens used daily, and Schedule, Transfers, Dashboard, Reports, End of day, Photo audit
 * and Roles - real screens that are opened weekly rather than hourly - are reached from here. A
 * screen that is off the strip must still be one obvious click away, or it is gone.
 *
 * `ops` marks a tile only a full-access account sees; a viewer has nothing to do on Roles. */
export const APP_TILES = [
  { hash: "#/chotu",      key: "nav.chotu",      icon: "🗣️", desc: "home.dChotu" },
  { hash: "#/production", key: "nav.production", icon: "✂️",  desc: "home.dProduction" },
  { hash: "#/prep",       key: "nav.prep",       icon: "🧵",  desc: "home.dPrep" },
  { hash: "#/status",     key: "nav.status",     icon: "🚚",  desc: "home.dInstall" },
  { hash: "#/schedule",   key: "nav.schedule",   icon: "🗓️", desc: "home.dSchedule" },
  { hash: "#/transfer",   key: "nav.transfer",   icon: "📦",  desc: "home.dTransfer" },
  { hash: "#/inventory",  key: "nav.inventory",  icon: "🔩",  desc: "home.dInventory" },
  { hash: "#/po",         key: "nav.po",         icon: "📄",  desc: "home.dPo" },
  { hash: "#/dashboard",  key: "nav.dashboard",  icon: "📊",  desc: "home.dDashboard" },
  { hash: "#/reports",    key: "nav.reports",    icon: "📈",  desc: "home.dReports" },
  { hash: "#/eod",        key: "nav.eod",        icon: "🌙",  desc: "home.dEod" },
  { hash: "#/audit",      key: "nav.audit",      icon: "📷",  desc: "home.dAudit" },
  { hash: "#/roles",      key: "nav.roles",      icon: "🔑",  desc: "home.dRoles", ops: true },
];

export const SITE_SOURCE = "https://sites.google.com/handpickedfurniture.com/links/home";
