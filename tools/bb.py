"""Attach to the downloader browser (tools/browser.sh) and run fetches inside a logged-in page."""
import json
import sys

from playwright.sync_api import sync_playwright

CDP = "http://127.0.0.1:9333"
LEARN = "https://learn.uq.edu.au"


class Browser:
    def __init__(self):
        self.pw = sync_playwright().start()
        try:
            self.browser = self.pw.chromium.connect_over_cdp(CDP)
        except Exception:
            sys.exit("The downloader browser isn't running. Start it with tools/browser.sh and log in.")
        self.context = self.browser.contexts[0]
        self._learn = None

    def learn_page(self):
        """A page on learn.uq.edu.au, so fetch() runs with the Blackboard session cookies."""
        if self._learn is None or self._learn.is_closed():
            self._learn = self.context.new_page()
            self._learn.goto(LEARN + "/ultra/course", wait_until="domcontentloaded")
            if "learn.uq.edu.au" not in self._learn.url:
                sys.exit("Not logged in to Learn.UQ. Log in in the downloader browser, then run this again.")
        return self._learn

    def get_json(self, path):
        page = self.learn_page()
        res = page.evaluate(
            """async (url) => {
                const r = await fetch(url, {credentials: 'same-origin', headers: {Accept: 'application/json'}});
                return {status: r.status, text: await r.text()};
            }""",
            path if path.startswith("http") else LEARN + path,
        )
        if res["status"] != 200:
            raise RuntimeError(f"{path}: HTTP {res['status']}: {res['text'][:300]}")
        return json.loads(res["text"])

    def close(self):
        if self._learn and not self._learn.is_closed():
            self._learn.close()
        self.pw.stop()
