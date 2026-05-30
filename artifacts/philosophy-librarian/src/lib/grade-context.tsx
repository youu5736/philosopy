import { createContext, useContext, useState, ReactNode } from "react";
import type { TextRecommendationInputGradeGroup } from "@workspace/api-client-react";

type GradeGroup = typeof TextRecommendationInputGradeGroup[keyof typeof TextRecommendationInputGradeGroup];

interface GradeContextType {
  grade: GradeGroup | null;
  setGrade: (grade: GradeGroup | null) => void;
}

const GradeContext = createContext<GradeContextType | undefined>(undefined);

export function GradeProvider({ children }: { children: ReactNode }) {
  const [grade, setGrade] = useState<GradeGroup | null>(null);

  return (
    <GradeContext.Provider value={{ grade, setGrade }}>
      {children}
    </GradeContext.Provider>
  );
}

export function useGrade() {
  const context = useContext(GradeContext);
  if (context === undefined) {
    throw new Error("useGrade must be used within a GradeProvider");
  }
  return context;
}
