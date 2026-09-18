"use client";
import EmojiPicker, { Categories, EmojiStyle, SuggestionMode, Theme } from "emoji-picker-react";
import { useT } from "@/components/locale-provider";

export default function FullEmojiPicker({ onSelect }: { onSelect: (emoji: string) => void }) {
  const t = useT();
  return <EmojiPicker width="100%" height={350} emojiStyle={EmojiStyle.NATIVE}
    theme={Theme.LIGHT} suggestedEmojisMode={SuggestionMode.RECENT}
    searchPlaceholder={t("Search emoji")} searchClearButtonLabel={t("Clear search")}
    previewConfig={{showPreview: false}} autoFocusSearch
    categories={[
      {category: Categories.SUGGESTED, name: t("Recently used")},
      {category: Categories.SMILEYS_PEOPLE, name: t("Smileys and people")},
      {category: Categories.ANIMALS_NATURE, name: t("Animals and nature")},
      {category: Categories.FOOD_DRINK, name: t("Food and drink")},
      {category: Categories.TRAVEL_PLACES, name: t("Travel and places")},
      {category: Categories.ACTIVITIES, name: t("Activities")},
      {category: Categories.OBJECTS, name: t("Objects")},
      {category: Categories.SYMBOLS, name: t("Symbols")},
      {category: Categories.FLAGS, name: t("Flags")},
    ]} onEmojiClick={emoji => onSelect(emoji.emoji)} />;
}
