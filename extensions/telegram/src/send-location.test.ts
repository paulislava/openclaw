import { afterEach, expect, it, vi } from "vitest";
import { sendLocationTelegram } from "./send-location.js";
import { sendLegacyLocationTelegram, sendVenueTelegram } from "./send-rich.js";

vi.mock("./send-location.js", () => ({ sendLocationTelegram: vi.fn() }));
vi.mock("./send-message.js", () => ({ sendMessageTelegram: vi.fn() }));
afterEach(() => vi.clearAllMocks());

it("maps the fork's location accuracy onto the canonical pin payload", async () => {
  const result = { messageId: "42", chatId: "100" };
  vi.mocked(sendLocationTelegram).mockResolvedValueOnce(result);
  const opts = { cfg: {}, replyToMessageId: 12, messageThreadId: 3 };
  expect(
    await sendLegacyLocationTelegram(
      "100",
      {
        latitude: 55.7558,
        longitude: 37.6173,
        horizontalAccuracy: 50,
      },
      opts,
    ),
  ).toEqual(result);
  expect(sendLocationTelegram).toHaveBeenCalledWith(
    "100",
    {
      latitude: 55.7558,
      longitude: 37.6173,
      accuracy: 50,
    },
    opts,
  );
});

it("maps a named venue and provider ids through the same native send owner", async () => {
  const opts = { cfg: {}, silent: true };
  await sendVenueTelegram(
    "100",
    {
      latitude: 55.7558,
      longitude: 37.6173,
      title: "Red Square",
      address: "Moscow",
      foursquareId: "fixture-venue",
      googlePlaceId: "fixture-place",
    },
    opts,
  );
  expect(sendLocationTelegram).toHaveBeenCalledWith(
    "100",
    {
      latitude: 55.7558,
      longitude: 37.6173,
      name: "Red Square",
      address: "Moscow",
    },
    { ...opts, foursquareId: "fixture-venue", googlePlaceId: "fixture-place" },
  );
});
