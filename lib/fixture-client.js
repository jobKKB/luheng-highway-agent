document.querySelector("#form").onsubmit = async (e) => {
  e.preventDefault();
  const session = new URL(location.href).searchParams.get("session");
  let r = await fetch(
    "/fixture/oa/submit?session=" + encodeURIComponent(session),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: document.querySelector("#title").value }),
    },
  );
  let d = await r.json();
  document.querySelector("#result").textContent = r.ok
    ? "已保存：" + d.title
    : d.error;
  if (r.ok) {
    const li = document.createElement("li");
    li.textContent = d.title + " · 已保存";
    document.querySelector("#records").append(li);
  }
};
