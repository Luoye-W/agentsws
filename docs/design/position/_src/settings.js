var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
var q = new URLSearchParams(location.search);
/* 小目录跟着滚动高亮 */
var secs = $$(".ss");
function spy() {
  var cur = secs[0].id;
  secs.forEach(function (s) { if (s.getBoundingClientRect().top < 140) cur = s.id; });
  $$("#toc a").forEach(function (a) { a.classList.toggle("on", a.getAttribute("href") === "#" + cur); });
}
addEventListener("scroll", spy, { passive: true });
$$("#toc a").forEach(function (a) { a.onclick = function (e) { e.preventDefault(); var t = $(a.getAttribute("href")); t.scrollIntoView({ behavior: "smooth", block: "start" }); if (t.id === "s-adv") $("#adv").open = true; }; });
/* 职责那一行的 ⋯：改名 / 移到别的岗位 / 拆成新岗位 / 拿掉 */
var menu = null;
function closeMenu() { if (menu) { menu.remove(); menu = null; } }
$$("[data-menu]").forEach(function (b) {
  b.onclick = function (e) {
    e.stopPropagation(); closeMenu();
    menu = document.createElement("div");
    menu.className = "pop menu";
    menu.innerHTML = '<button class="opt" type="button"><svg class="ico s14"><use href="#i-pen"/></svg>改名</button><button class="opt" type="button"><svg class="ico s14"><use href="#i-go"/></svg>移到别的岗位…</button><button class="opt" type="button"><svg class="ico s14"><use href="#i-split"/></svg>拆出去，单独成一个岗位</button><hr><button class="opt bad" type="button"><svg class="ico s14"><use href="#i-x"/></svg>从这个岗位拿掉</button>';
    b.closest(".li").appendChild(menu);
  };
});
document.addEventListener("click", function (e) { if (menu && !menu.contains(e.target)) closeMenu(); });
/* 开关 */
$$(".toggle").forEach(function (t) { t.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); t.classList.toggle("on"); if (t.id === "devToggle") $("#cap").classList.toggle("dev", t.classList.contains("on")); }); });
/* 截图参数：?adv=1 展开高级、?dev=1 开发者视图、?menu=1 打开第二条职责的菜单 */
if (q.get("adv") || q.get("dev")) $("#adv").open = true;
if (q.get("dev")) $("#devToggle").click();
if (q.get("menu")) $$("[data-menu]")[1].click();
