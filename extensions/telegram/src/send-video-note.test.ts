import { afterEach, expect, it, vi } from "vitest";
import { sendMessageTelegram } from "./send-message.js";
import { sendVideoNoteTelegram } from "./send-rich.js";

vi.mock("./send-message.js", () => ({ sendMessageTelegram: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it("routes a video note through the current native send owner", async () => {
  const result = { messageId: "55", chatId: "200" };
  vi.mocked(sendMessageTelegram).mockResolvedValueOnce(result);
  const opts = { cfg: {}, accountId: "other", replyToMessageId: 12 };
  expect(await sendVideoNoteTelegram("200", "https://example.com/clip.mp4", opts)).toEqual(result);
  expect(sendMessageTelegram).toHaveBeenCalledWith("200", "", {
    ...opts,
    mediaUrl: "https://example.com/clip.mp4",
    asVideoNote: true,
  });
});

it("rejects empty media before a send", async () => {
  await expect(sendVideoNoteTelegram("200", " ", { cfg: {} })).rejects.toThrow("mediaUrl");
  expect(sendMessageTelegram).not.toHaveBeenCalled();
});
