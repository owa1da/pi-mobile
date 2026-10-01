import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";
import { observeI18nInit } from "./init";
import { en } from "./resources/en";

const i18n = createInstance();

observeI18nInit(
  i18n.use(initReactI18next).init({
    compatibilityJSON: "v4",
    fallbackLng: "en",
    lng: "en",
    resources: {
      en: { translation: en },
    },
    interpolation: {
      escapeValue: false,
    },
    react: {
      useSuspense: false,
    },
  }),
);

export { i18n };
