var ta = document.getElementById("firstText");
Array.prototype.forEach.call(document.querySelectorAll(".first .sug"), function (s) { s.onclick = function () { ta.value = s.textContent; ta.focus(); }; });
if (new URLSearchParams(location.search).get("focus")) ta.focus();
