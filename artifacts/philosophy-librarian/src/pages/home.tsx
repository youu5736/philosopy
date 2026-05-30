import { useLocation } from "wouter";
import { BookOpen, Sparkles } from "lucide-react";
import { useGrade } from "@/lib/grade-context";
import owlImage from "@/assets/images/librarian-owl.png";

export default function Home() {
  const [, setLocation] = useLocation();
  const { setGrade } = useGrade();

  const handleSelectGrade = (grade: "lower" | "upper") => {
    setGrade(grade);
    setLocation("/recommend");
  };

  return (
    <div className="min-h-[100dvh] w-full flex flex-col items-center justify-center p-6 relative overflow-hidden">
      {/* Decorative background elements */}
      <div className="absolute top-[-10%] left-[-10%] w-96 h-96 bg-primary/20 rounded-full blur-3xl" />
      <div className="absolute bottom-[-10%] right-[-10%] w-96 h-96 bg-secondary/20 rounded-full blur-3xl" />
      
      <div className="z-10 max-w-2xl w-full text-center space-y-12">
        <div className="space-y-6 animate-in fade-in slide-in-from-bottom-8 duration-700">
          <div className="relative inline-block">
            <img 
              src={owlImage} 
              alt="Librarian Owl" 
              className="w-48 h-48 mx-auto drop-shadow-xl hover:scale-105 transition-transform duration-500"
            />
            <div className="absolute -top-4 -right-4 bg-white px-4 py-2 rounded-2xl rounded-bl-none shadow-md border border-border text-foreground font-display text-xl animate-bounce">
              안녕! 👋
            </div>
          </div>
          <h1 className="text-4xl md:text-5xl lg:text-6xl font-display text-foreground leading-tight">
            마음 튼튼 <span className="text-primary-foreground relative">
              철학 사서
              <Sparkles className="absolute -top-6 -right-8 w-8 h-8 text-accent-foreground" />
            </span>
          </h1>
          <p className="text-xl md:text-2xl text-muted-foreground max-w-lg mx-auto leading-relaxed">
            너의 마음을 이야기해주면, 딱 맞는 철학 책을 찾아줄게.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6 w-full px-4 animate-in fade-in slide-in-from-bottom-12 duration-700 delay-150 fill-mode-both">
          <button
            onClick={() => handleSelectGrade("lower")}
            className="group relative bg-white border-2 border-primary/30 p-8 rounded-[2rem] shadow-sm hover:shadow-xl hover:border-primary/60 transition-all duration-300 hover:-translate-y-2 text-center"
          >
            <div className="w-16 h-16 mx-auto bg-primary/20 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
              <span className="text-3xl">🌱</span>
            </div>
            <h2 className="text-3xl font-display mb-2 text-foreground">저학년</h2>
            <p className="text-lg text-muted-foreground">1~3학년 친구들</p>
          </button>

          <button
            onClick={() => handleSelectGrade("upper")}
            className="group relative bg-white border-2 border-secondary/30 p-8 rounded-[2rem] shadow-sm hover:shadow-xl hover:border-secondary/60 transition-all duration-300 hover:-translate-y-2 text-center"
          >
            <div className="w-16 h-16 mx-auto bg-secondary/20 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
              <span className="text-3xl">🌳</span>
            </div>
            <h2 className="text-3xl font-display mb-2 text-foreground">고학년</h2>
            <p className="text-lg text-muted-foreground">4~6학년 친구들</p>
          </button>
        </div>
      </div>
    </div>
  );
}
