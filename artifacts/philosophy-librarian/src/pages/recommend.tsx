import { useEffect, useState, useRef } from "react";
import { useLocation } from "wouter";
import { useGrade } from "@/lib/grade-context";
import { 
  useRecommendByText, 
  useRecommendByImage,
  useGenerateInterestKeywords,
  useRecommendByKeyword,
  useChatWithPhilosopher
} from "@workspace/api-client-react";
import type { BookRecommendation, InterestKeywordOption, PhilosopherChatMessage } from "@workspace/api-client-react";
import { 
  Tabs, 
  TabsContent, 
  TabsList, 
  TabsTrigger 
} from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { 
  BookOpen, 
  Camera, 
  Upload, 
  Send, 
  ArrowLeft,
  Loader2,
  AlertCircle,
  Sparkles,
  Compass,
  Lightbulb,
  MessageCircle,
  UserRound
} from "lucide-react";
import owlImage from "@/assets/images/librarian-owl.png";

export default function RecommendPage() {
  const [, setLocation] = useLocation();
  const { grade } = useGrade();
  
  const [textInput, setTextInput] = useState("");
  const [interestInput, setInterestInput] = useState("");
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [result, setResult] = useState<BookRecommendation | null>(null);
  const [interestKeywords, setInterestKeywords] = useState<InterestKeywordOption[] | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatMessages, setChatMessages] = useState<PhilosopherChatMessage[]>([]);
  const [philosopherName, setPhilosopherName] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);

  // Redirect if no grade selected
  useEffect(() => {
    if (!grade) {
      setLocation("/");
    }
  }, [grade, setLocation]);

  const textMutation = useRecommendByText();
  const imageMutation = useRecommendByImage();
  const keywordMutation = useGenerateInterestKeywords();
  const keywordRecommendMutation = useRecommendByKeyword();
  const philosopherChatMutation = useChatWithPhilosopher();

  const isPending =
    textMutation.isPending ||
    imageMutation.isPending ||
    keywordMutation.isPending ||
    keywordRecommendMutation.isPending;

  const resetChat = () => {
    setChatOpen(false);
    setChatInput("");
    setChatMessages([]);
    setPhilosopherName(null);
  };

  const handleApiError = (error: any) => {
    const msg = error?.response?.data?.error || error?.message || "";
    if (msg.toLowerCase().includes("api key") || msg.toLowerCase().includes("config")) {
      setApiError("AI 사서 선생님이 아직 준비 중이에요! 관리자에게 API 키 설정을 부탁해 주세요. 🔑");
    } else {
      setApiError("앗, 책을 찾는 중에 문제가 생겼어요. 다시 한 번 시도해줄래요? 😥");
    }
  };

  const handleTextSubmit = () => {
    if (!textInput.trim() || !grade) return;
    setApiError(null);
    setResult(null);
    setInterestKeywords(null);
    resetChat();
    
    textMutation.mutate(
      { data: { text: textInput, gradeGroup: grade, searchType: "emotion" } },
      {
        onSuccess: (data) => setResult(data),
        onError: handleApiError
      }
    );
  };

  const handleInterestSubmit = () => {
    if (!interestInput.trim() || !grade) return;
    setApiError(null);
    setResult(null);
    setInterestKeywords(null);
    resetChat();

    keywordMutation.mutate(
      { data: { text: interestInput, gradeGroup: grade } },
      {
        onSuccess: (data) => setInterestKeywords(data.keywords),
        onError: handleApiError
      }
    );
  };

  const handleInterestKeywordSelect = (option: InterestKeywordOption) => {
    if (!grade) return;
    setApiError(null);
    setResult(null);
    resetChat();

    keywordRecommendMutation.mutate(
      {
        data: {
          keyword: option.keyword,
          originalText: interestInput,
          gradeGroup: grade,
        },
      },
      {
        onSuccess: (data) => setResult(data),
        onError: handleApiError,
      }
    );
  };

  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      setImageFile(file);
      
      const reader = new FileReader();
      reader.onload = (event) => {
        setImagePreview(event.target?.result as string);
      };
      reader.readAsDataURL(file);
    }
  };

  const handleImageDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.type.startsWith('image/')) {
        setImageFile(file);
        const reader = new FileReader();
        reader.onload = (event) => {
          setImagePreview(event.target?.result as string);
        };
        reader.readAsDataURL(file);
      }
    }
  };

  const handleImageSubmit = () => {
    if (!imagePreview || !imageFile || !grade) return;
    setApiError(null);
    setResult(null);
    setInterestKeywords(null);
    resetChat();

    // remove data URL prefix
    const base64 = imagePreview.split(',')[1];
    
    imageMutation.mutate(
      { 
        data: { 
          imageBase64: base64, 
          mimeType: imageFile.type,
          gradeGroup: grade 
        } 
      },
      {
        onSuccess: (data) => setResult(data),
        onError: handleApiError
      }
    );
  };

  const resetFlow = () => {
    setResult(null);
    setTextInput("");
    setInterestInput("");
    setInterestKeywords(null);
    setImageFile(null);
    setImagePreview(null);
    setApiError(null);
    resetChat();
  };

  const handleSendChat = () => {
    const message = chatInput.trim();
    if (!message || !result || !grade || philosopherChatMutation.isPending) return;

    const studentMessage: PhilosopherChatMessage = {
      role: "student",
      content: message,
    };
    const history = chatMessages;

    setChatInput("");
    setChatMessages((messages) => [...messages, studentMessage]);

    philosopherChatMutation.mutate(
      {
        data: {
          message,
          history,
          gradeGroup: grade,
          bookTitle: result.bookTitle,
          bookAuthor: result.bookAuthor,
          philosophyKnowledge: result.philosophyKnowledge,
          recommendationReason: result.recommendationReason,
          thinkingQuestion: result.thinkingQuestion,
          philosopherName: result.philosopherName,
          philosophicalLens: result.philosophicalLens,
        },
      },
      {
        onSuccess: (data) => {
          setPhilosopherName(data.philosopherName);
          setChatMessages((messages) => [
            ...messages,
            { role: "philosopher", content: data.reply },
          ]);
        },
        onError: () => {
          setChatMessages((messages) => [
            ...messages,
            {
              role: "philosopher",
              content: "잠깐 생각이 길어졌구나. 다시 한 번 천천히 물어봐 줄래?",
            },
          ]);
        },
      }
    );
  };

  if (!grade) return null;

  return (
    <div className="min-h-[100dvh] w-full bg-background p-4 md:p-8 flex flex-col items-center">
      <div className="w-full max-w-4xl flex items-center justify-between mb-8 animate-in fade-in duration-500">
        <button 
          onClick={() => setLocation("/")}
          className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors font-display text-lg"
        >
          <ArrowLeft className="w-5 h-5" />
          <span>처음으로</span>
        </button>
        
        <div className="flex items-center gap-3 bg-white px-4 py-2 rounded-full shadow-sm border border-border">
          <span className="text-2xl">{grade === "lower" ? "🌱" : "🌳"}</span>
          <span className="font-display text-foreground text-lg">
            {grade === "lower" ? "저학년 (1~3학년)" : "고학년 (4~6학년)"}
          </span>
        </div>
      </div>

      <div className="w-full max-w-4xl relative">
        <div className="absolute -top-12 -right-4 md:-right-12 w-32 h-32 hidden md:block animate-pulse" style={{ animationDuration: '4s' }}>
          <img src={owlImage} alt="Owl" className="w-full h-full object-contain opacity-90" />
        </div>

        {apiError && (
          <div className="bg-destructive/10 border-2 border-destructive/30 text-destructive-foreground p-6 rounded-3xl mb-8 flex items-start gap-4 animate-in fade-in slide-in-from-top-4">
            <AlertCircle className="w-6 h-6 shrink-0 mt-1" />
            <p className="text-xl font-display leading-relaxed">{apiError}</p>
          </div>
        )}

        {!result ? (
          <div className="bg-white p-6 md:p-10 rounded-[2.5rem] shadow-xl border border-border animate-in zoom-in-95 duration-500">
            <h2 className="text-3xl font-display text-center mb-8 text-foreground">
              어떤 방법으로 책을 찾아볼까?
            </h2>

            <Tabs defaultValue="text" className="w-full">
              <TabsList className="grid w-full grid-cols-3 h-auto rounded-2xl bg-muted p-2 mb-8 gap-1">
                <TabsTrigger 
                  value="text" 
                  className="rounded-xl py-3 text-base font-display data-[state=active]:bg-white data-[state=active]:text-primary-foreground data-[state=active]:shadow-sm flex flex-col sm:flex-row items-center gap-1"
                >
                  <BookOpen className="w-5 h-5 shrink-0" />
                  <span>감정으로 찾기</span>
                </TabsTrigger>
                <TabsTrigger 
                  value="interest"
                  className="rounded-xl py-3 text-base font-display data-[state=active]:bg-white data-[state=active]:text-accent-foreground data-[state=active]:shadow-sm flex flex-col sm:flex-row items-center gap-1"
                >
                  <Compass className="w-5 h-5 shrink-0" />
                  <span>관심사로 찾기</span>
                </TabsTrigger>
                <TabsTrigger 
                  value="image"
                  className="rounded-xl py-3 text-base font-display data-[state=active]:bg-white data-[state=active]:text-secondary-foreground data-[state=active]:shadow-sm flex flex-col sm:flex-row items-center gap-1"
                >
                  <Camera className="w-5 h-5 shrink-0" />
                  <span>책 표지로 찾기</span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="text" className="space-y-6 animate-in fade-in">
                <div className="space-y-4">
                  <label className="text-xl font-display text-foreground block px-2">
                    지금 기분을 적어줘
                  </label>
                  <Textarea 
                    placeholder="예: 친구랑 다퉈서 속상해. 어떻게 화해하면 좋을까?"
                    className="min-h-[200px] text-xl p-6 rounded-3xl resize-none border-2 focus-visible:ring-primary/50 focus-visible:border-primary shadow-inner bg-background/50"
                    value={textInput}
                    onChange={(e) => setTextInput(e.target.value)}
                    disabled={isPending}
                  />
                </div>
                
                <div className="flex justify-end">
                  <Button 
                    size="lg" 
                    className="rounded-full px-8 py-6 text-xl font-display bg-primary hover:bg-primary/90 text-primary-foreground shadow-md transition-all hover:scale-105"
                    onClick={handleTextSubmit}
                    disabled={!textInput.trim() || isPending}
                  >
                    {isPending ? (
                      <><Loader2 className="mr-2 h-6 w-6 animate-spin" /> 찾고 있어요...</>
                    ) : (
                      <><Send className="mr-2 h-6 w-6" /> 사서 선생님에게 물어보기</>
                    )}
                  </Button>
                </div>
              </TabsContent>

              <TabsContent value="interest" className="space-y-6 animate-in fade-in">
                <div className="space-y-4">
                  <label className="text-xl font-display text-foreground block px-2">
                    지금 가장 관심 있는 주제나 분야를 적어줘!
                  </label>
                  <Textarea 
                    placeholder="예: 우주, 역사, 로봇, 공룡, 요리 등"
                    className="min-h-[200px] text-xl p-6 rounded-3xl resize-none border-2 focus-visible:ring-accent/50 focus-visible:border-accent shadow-inner bg-background/50"
                    value={interestInput}
                    onChange={(e) => {
                      setInterestInput(e.target.value);
                      setInterestKeywords(null);
                    }}
                    disabled={isPending}
                  />
                </div>
                
                <div className="flex justify-end">
                  <Button 
                    size="lg" 
                    className="rounded-full px-8 py-6 text-xl font-display bg-accent hover:bg-accent/90 text-accent-foreground shadow-md transition-all hover:scale-105"
                    onClick={handleInterestSubmit}
                    disabled={!interestInput.trim() || isPending}
                  >
                    {isPending ? (
                      <><Loader2 className="mr-2 h-6 w-6 animate-spin" /> 찾고 있어요...</>
                    ) : (
                      <><Compass className="mr-2 h-6 w-6" /> 탐구 키워드 만들기</>
                    )}
                  </Button>
                </div>

                {interestKeywords && (
                  <div className="grid gap-4 pt-2 md:grid-cols-3 animate-in fade-in slide-in-from-bottom-4">
                    {interestKeywords.map((option) => (
                      <button
                        key={`${option.title}-${option.keyword}`}
                        type="button"
                        onClick={() => handleInterestKeywordSelect(option)}
                        disabled={isPending}
                        className="group min-h-44 rounded-3xl border-2 border-accent/30 bg-accent/10 p-5 text-left shadow-sm transition-all hover:-translate-y-1 hover:border-accent/70 hover:bg-accent/20 hover:shadow-md disabled:pointer-events-none disabled:opacity-60"
                      >
                        <div className="mb-3 flex items-center gap-2 text-accent-foreground">
                          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-white shadow-sm">
                            <Lightbulb className="h-5 w-5" />
                          </span>
                          <span className="text-lg font-display leading-tight">
                            {option.title}
                          </span>
                        </div>
                        <p className="mb-4 text-base leading-relaxed text-foreground">
                          {option.description}
                        </p>
                        <span className="inline-flex rounded-full bg-white px-3 py-1 text-sm font-medium text-muted-foreground shadow-sm">
                          {option.keyword}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="image" className="space-y-6 animate-in fade-in">
                 <div className="space-y-4">
                  <label className="text-xl font-display text-foreground block px-2">
                    지금 읽고 있는 책이나 좋아하는 책 표지를 찍어줘! 비슷한 책을 찾아줄게.
                  </label>
                  
                  <div 
                    className={`border-4 border-dashed rounded-[2.5rem] p-12 text-center transition-colors cursor-pointer flex flex-col items-center justify-center min-h-[300px] relative overflow-hidden ${imagePreview ? 'border-secondary/50 bg-secondary/5' : 'border-border hover:border-secondary/50 hover:bg-secondary/5'}`}
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={handleImageDrop}
                  >
                    <input 
                      type="file" 
                      accept="image/*" 
                      className="hidden" 
                      ref={fileInputRef}
                      onChange={handleImageFileChange}
                      disabled={isPending}
                    />
                    
                    {imagePreview ? (
                      <div className="absolute inset-0 p-4 flex items-center justify-center">
                        <img src={imagePreview} alt="Preview" className="max-h-full max-w-full object-contain rounded-2xl shadow-md" />
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 hover:opacity-100 transition-opacity rounded-[2.5rem]">
                          <p className="text-white font-display text-xl">다시 선택하기</p>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-4 text-muted-foreground pointer-events-none">
                        <div className="w-20 h-20 bg-secondary/20 rounded-full flex items-center justify-center mx-auto">
                          <Upload className="w-10 h-10 text-secondary-foreground" />
                        </div>
                        <p className="text-xl font-display">여기를 눌러서 사진을 선택하거나<br/>사진을 끌어와 줘!</p>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex justify-end">
                  <Button 
                    size="lg" 
                    className="rounded-full px-8 py-6 text-xl font-display bg-secondary hover:bg-secondary/90 text-secondary-foreground shadow-md transition-all hover:scale-105"
                    onClick={handleImageSubmit}
                    disabled={!imageFile || isPending}
                  >
                    {isPending ? (
                      <><Loader2 className="mr-2 h-6 w-6 animate-spin" /> 찾고 있어요...</>
                    ) : (
                      <><Sparkles className="mr-2 h-6 w-6" /> 비슷한 책 찾아보기</>
                    )}
                  </Button>
                </div>
              </TabsContent>
            </Tabs>
          </div>
        ) : (
          <div className="space-y-8 animate-in fade-in slide-in-from-bottom-12 duration-700">
            <div className="bg-white rounded-[2.5rem] p-8 md:p-12 shadow-2xl border-2 border-primary/20 relative overflow-hidden">
              <div className="absolute top-0 right-0 w-64 h-64 bg-accent/20 rounded-full blur-3xl -z-10" />
              <div className="absolute bottom-0 left-0 w-64 h-64 bg-primary/10 rounded-full blur-3xl -z-10" />
              
              <div className="space-y-10 relative z-10">
                {/* 💬 따뜻한 공감의 한마디 */}
                <div className="bg-accent/30 rounded-3xl p-6 md:p-8">
                  <h3 className="text-2xl font-display text-accent-foreground mb-4 flex items-center gap-2">
                    <span className="text-3xl">💬</span> 따뜻한 공감의 한마디
                  </h3>
                  <p className="text-xl md:text-2xl leading-relaxed text-foreground whitespace-pre-wrap">
                    {result.empathyMessage}
                  </p>
                </div>

                {/* Detected Book (if any) */}
                {result.detectedBook && (
                  <div className="inline-flex items-center gap-2 bg-secondary/20 px-5 py-3 rounded-full text-secondary-foreground font-display text-lg">
                    <span className="text-2xl">📖</span>
                    인식된 책: {result.detectedBook}
                  </div>
                )}

                {/* 📚 추천 도서 */}
                <div className="bg-white border-4 border-primary/30 rounded-3xl p-6 md:p-8 shadow-sm">
                  <h3 className="text-2xl font-display text-primary-foreground mb-6 flex items-center gap-2">
                    <span className="text-3xl">📚</span> 추천 도서
                  </h3>
                  <div className="flex flex-col sm:flex-row gap-6 items-center sm:items-start">
                    {result.coverUrl && (
                      <div className="shrink-0 w-36 h-48 rounded-2xl overflow-hidden shadow-lg border-2 border-primary/20">
                        <img
                          src={result.coverUrl}
                          alt={result.bookTitle}
                          className="w-full h-full object-cover"
                          onError={(e) => {
                            (e.currentTarget as HTMLImageElement).style.display = "none";
                          }}
                        />
                      </div>
                    )}
                    <div className="flex flex-col justify-center text-center sm:text-left gap-2">
                      <div className="text-3xl md:text-4xl font-display text-foreground leading-tight">
                        《{result.bookTitle}》
                      </div>
                      <div className="text-xl text-muted-foreground">
                        지은이: {result.bookAuthor}
                      </div>
                      {result.publisher && (
                        <div className="text-lg text-muted-foreground/80">
                          출판사: {result.publisher}
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                {/* 💡 선생님의 추천 이유 */}
                <div className="bg-muted/50 rounded-3xl p-6 md:p-8">
                  <h3 className="text-2xl font-display text-foreground mb-4 flex items-center gap-2">
                    <span className="text-3xl">💡</span> 선생님의 추천 이유
                  </h3>
                  <p className="text-lg md:text-xl leading-relaxed text-foreground">
                    {result.recommendationReason}
                  </p>
                </div>

                {/* 🏛️ 철학 돋보기 */}
                {result.philosophyKnowledge && (
                  <div className="relative rounded-3xl p-6 md:p-8 overflow-hidden border-2 border-amber-200/60"
                    style={{ background: "linear-gradient(135deg, #fefce8 0%, #fef9c3 50%, #fef3c7 100%)" }}>
                    <div className="absolute top-0 right-0 w-40 h-40 opacity-5 pointer-events-none select-none"
                      style={{ fontSize: "120px", lineHeight: 1, transform: "translate(20%, -20%)" }}>
                      🏛️
                    </div>
                    <h3 className="text-2xl font-display mb-4 flex items-center gap-2"
                      style={{ color: "#92400e" }}>
                      <span className="text-3xl">🏛️</span> 오늘의 철학 한 조각
                    </h3>
                    <p className="text-lg md:text-xl leading-relaxed"
                      style={{ color: "#78350f" }}>
                      {result.philosophyKnowledge}
                    </p>
                    <Button
                      type="button"
                      className="mt-6 rounded-full px-6 py-5 text-lg font-display bg-amber-700 text-white shadow-md hover:bg-amber-800"
                      onClick={() => setChatOpen(true)}
                    >
                      <MessageCircle className="mr-2 h-5 w-5" />
                      철학자와 대화하기
                    </Button>
                  </div>
                )}

                {/* 🌱 마음 씨앗 질문 */}
                <div className="bg-primary/10 rounded-3xl p-6 md:p-8 border-2 border-primary/20">
                  <h3 className="text-2xl font-display text-primary-foreground mb-4 flex items-center gap-2">
                    <span className="text-3xl">🌱</span> 마음 씨앗 질문
                  </h3>
                  <p className="text-xl md:text-2xl font-display text-foreground leading-relaxed">
                    {result.thinkingQuestion}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex justify-center">
              <Button 
                size="lg" 
                variant="outline"
                className="rounded-full px-8 py-6 text-xl font-display bg-white shadow-sm hover:shadow-md transition-all border-2"
                onClick={resetFlow}
              >
                다른 책도 추천받기
              </Button>
            </div>

            <Dialog open={chatOpen} onOpenChange={setChatOpen}>
              <DialogContent className="flex h-[88dvh] max-h-[760px] max-w-2xl flex-col rounded-3xl p-0 overflow-hidden">
                <DialogHeader className="shrink-0 border-b bg-amber-50 px-6 py-5">
                  <DialogTitle className="flex items-center gap-2 text-2xl font-display text-amber-950">
                    <UserRound className="h-6 w-6" />
                    {philosopherName || result.philosopherName
                      ? `${philosopherName ?? result.philosopherName}와 대화하기`
                      : "철학자와 대화하기"}
                  </DialogTitle>
                  <DialogDescription className="text-base text-amber-900/80">
                    추천받은 책과 오늘의 질문을 바탕으로 자유롭게 이야기해 보세요.
                  </DialogDescription>
                </DialogHeader>

                <div className="flex min-h-0 flex-1 flex-col bg-background">
                  <ScrollArea className="min-h-0 flex-1 px-6 py-5">
                    <div className="space-y-4 pr-3">
                      {chatMessages.length === 0 && (
                        <div className="rounded-3xl border border-amber-200 bg-amber-50 p-5 text-amber-950">
                          <p className="text-lg font-display leading-relaxed">
                            《{result.bookTitle}》을 읽으며 떠오른 생각을 물어보세요.
                          </p>
                          <p className="mt-2 text-base leading-relaxed text-amber-900/80">
                            예: 이 책의 주인공은 왜 그런 선택을 했을까요?
                          </p>
                        </div>
                      )}

                      {chatMessages.map((message, index) => {
                        const isStudent = message.role === "student";
                        return (
                          <div
                            key={`${message.role}-${index}`}
                            className={`flex ${isStudent ? "justify-end" : "justify-start"}`}
                          >
                            <div
                              className={`max-w-[82%] rounded-3xl px-5 py-4 text-base leading-relaxed shadow-sm ${
                                isStudent
                                  ? "bg-primary text-primary-foreground"
                                  : "bg-white border border-amber-200 text-foreground"
                              }`}
                            >
                              <div className="mb-1 text-sm font-semibold opacity-80">
                                {isStudent ? "나" : philosopherName ?? result.philosopherName ?? "철학자"}
                              </div>
                              <p className="whitespace-pre-wrap">{message.content}</p>
                            </div>
                          </div>
                        );
                      })}

                      {philosopherChatMutation.isPending && (
                        <div className="flex justify-start">
                          <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-white px-4 py-3 text-amber-900 shadow-sm">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            생각을 정리하고 있어요
                          </div>
                        </div>
                      )}
                    </div>
                  </ScrollArea>

                  <div className="shrink-0 border-t bg-white p-4">
                    <div className="flex flex-col gap-3 sm:flex-row">
                      <Textarea
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            handleSendChat();
                          }
                        }}
                        placeholder="철학자에게 궁금한 점을 써 보세요"
                        className="min-h-24 flex-1 resize-none rounded-2xl border-2 text-base"
                        disabled={philosopherChatMutation.isPending}
                      />
                      <Button
                        type="button"
                        className="h-auto rounded-2xl px-6 py-4 text-lg font-display sm:self-stretch"
                        onClick={handleSendChat}
                        disabled={!chatInput.trim() || philosopherChatMutation.isPending}
                      >
                        {philosopherChatMutation.isPending ? (
                          <Loader2 className="h-5 w-5 animate-spin" />
                        ) : (
                          <Send className="h-5 w-5" />
                        )}
                        <span className="ml-2">보내기</span>
                      </Button>
                    </div>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        )}
      </div>
    </div>
  );
}
