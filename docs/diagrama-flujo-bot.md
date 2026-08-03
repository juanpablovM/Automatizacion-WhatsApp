```mermaid
flowchart TD
    %% ============================================================
    %% FLUJO CONVERSACIONAL HORMI ATENCIÓN — State Machine Diagram
    %% ============================================================
    
    subgraph ENTRADA["ENTRADA MENSAJE"]
        A[Cliente WhatsApp] --> B[Evolution API Webhook]
        B --> C[WA - Inbound Entry]
        C --> D{Validación webhook + dedup}
        D -->|OK| E[WA - Conversation Orchestrator]
        D -->|Error| F[Respuesta error genérica]
    end
    
    subgraph ORQUESTADOR["WA - CONVERSATION ORCHESTRATOR"]
        E --> G["Load Conversation State (PostgreSQL)"]
        G --> H["Evaluate Conversation Step -- LÓGICA DETERMINÍSTICA"]
        
        H --> I{Análisis mensaje}
        I -->|Saludo puro| J[welcome_and_question / recontact_greeting]
        I -->|Pide humano| K[escalation_routing human_requested]
        I -->|Ya escalado/derivado| L{¿Es 'nueva cotización'?}
        L -->|Sí| M[Reset → city]
        L -->|No| N[escalation_already_required]
        I -->|En confirmación final| O{Usuario confirma?}
        O -->|"Sí (sí/ok/dale)"| P[shouldCreateLead=true → handoff_ready]
        O -->|"No (no/incorrecto)"| Q[confirmation_correction_requested]
        I -->|En corrección| R[confirm_retry_N]
        I -->|Detecta B2B keywords| S[b2b_redirect Plantilla 8 campos]
        I -->|Frustración / bucle 3+| T[escalation_routing frustration_detected / loop_detected]
        I -->|Intención + datos| U[Extrae city/service/requirement]
        
        U --> V["Execute AI Lead Qualification -- LLAMA GEMINI"]
        V --> W[Merge AI Assistance]
        W --> X["Apply AI Assistance -- SELECCIÓN RESPUESTA"]
    end
    
    subgraph SELECCION_RESPUESTA["APPLY AI ASSISTANCE — Prioridades"]
        X --> Y{shouldCreateLead?}
        Y -->|Sí| Z1[PRIORIDAD 1: Lead Creation]
        Z1 --> Z1a{aiReplyAcceptable + PRD OK?}
        Z1a -->|Sí| Z1b[kind=handoff_pending texto='']
        Z1a -->|No| Z1c[kind=prd_validated_fallback fallback validador]
        
        Y -->|No| AA{isEscalation / correctionTurn?}
        AA -->|Sí| AB[PRIORIDAD 2: Terminal Policies]
        AB --> ABa[Escalation → escalation_routing]
        AB --> ABb[Corrección → '¿Qué dato corregir?']
        
        AA -->|No| AC{aiReplyAcceptable + reply_text?}
        AC -->|Sí| AD[PRIORIDAD 3: AI Reply]
        AD --> ADa{PRD Validators}
        ADa -->|Pasa| ADb{Clasifica tipo}
        ADb -->|objection_detected| ADc[kind=objection_response]
        ADb -->|B2B| ADd[kind=b2b_response]
        ADb -->|missing=confirm| ADe[kind=confirmation_question]
        ADb -->|redirect intents| ADf[kind=ai_redirect]
        ADb -->|default| ADg[kind=ai_conversation / ai_enhancement]
        ADa -->|Falla| ADh[kind=prd_validated_fallback]
        
        AC -->|No| AI{acceptedAiFields.length > 0?}
        AI -->|Sí| AJ[PRIORIDAD 4: AI-assisted Question]
        AJ --> AJa{missing=confirm?}
        AJa -->|Sí| AJb["confirmationText()"]
        AJa -->|No| AJc["nextQuestion(missing)"]
        
        AI -->|No| AK[PRIORIDAD 5: Fallback Determinístico]
        AK --> AKa[deterministic.deterministic_reply]
    end
    
    subgraph PERSISTENCIA["PERSISTENCIA + OUTBOUND"]
        Z1b --> AL["Persist Conversation State (PostgreSQL TX)"]
        ADb --> AL
        ADh --> AL
        AJb --> AL
        AJc --> AL
        AKa --> AL
        ABa --> AL
        ABb --> AL
        N --> AL
        M --> AL
        J --> AL
        Q --> AL
        R --> AL
        S --> AL
        T --> AL
        
        AL --> AM[WA - Outbound Messages Evolution API sendMessage]
    end
    
    subgraph POST_LEAD["POST-LEAD (solo si shouldCreateLead)"]
        AL --> AN{shouldCreateLead?}
        AN -->|Sí| AO[CRM - Lead Creation & Assignment]
        AO --> AP[CRM - ClickUp Sync Lead]
        AP --> AQ[CRM - Seller Notification Dispatch]
        AQ --> AR[Cliente recibe: 'Te derivaré con ejecutiva...']
    end
    
    %% Estados current_step_field
    subgraph ESTADOS["ESTADOS current_step_field"]
        EST_CITY[city]
        EST_SERVICE[service]
        EST_REQ[requirement]
        EST_CONFIRM[confirm]
        EST_CONFIRM_R1[confirm_retry_1]
        EST_CONFIRM_R2[confirm_retry_2]
        EST_COMPLETE[complete]
        EST_ESCALATION[escalation]
        EST_PREV_CTX[previous_context]
        EST_HANDOFF[handoff_ready / handoff_pending]
    end
    
    %% Conexiones de estado
    H -.-> EST_CITY
    H -.-> EST_SERVICE
    H -.-> EST_REQ
    O -.-> EST_CONFIRM
    Q -.-> EST_CONFIRM_R1
    R -.-> EST_CONFIRM_R2
    P -.-> EST_COMPLETE
    T -.-> EST_ESCALATION
    K -.-> EST_ESCALATION
    L -.-> EST_ESCALATION
    N -.-> EST_ESCALATION
    
    %% Estilos
    classDef entry fill:#e3f2fd,stroke:#1565c0,stroke-width:2px;
    classDef orch fill:#fff3e0,stroke:#ef6c00,stroke-width:2px;
    classDef ai fill:#fce4ec,stroke:#c2185b,stroke-width:2px;
    classDef priority fill:#e8eaf6,stroke:#3f51b5,stroke-width:2px;
    classDef persist fill:#e8f5e9,stroke:#2e7d32,stroke-width:2px;
    classDef post fill:#f3e5f5,stroke:#7b1fa2,stroke-width:2px;
    classDef state fill:#fffde7,stroke:#fbc02d,stroke-width:1px,stroke-dasharray: 5 5;
    
    class A,B,C,D,E,F entry;
    class E,G,H,I,J,K,L,M,N,O,P,Q,R,S,T,U,V,W,X orch;
    class Y,Z1,Z1a,Z1b,Z1c,AA,AB,ABa,ABb,AC,AD,ADa,ADb,ADc,ADd,ADe,ADf,ADg,ADh,AI,AJ,AJa,AJb,AJc,AK,AKa ai;
    class AL,AM persist;
    class AN,AO,AP,AQ,AR post;
    class EST_CITY,EST_SERVICE,EST_REQ,EST_CONFIRM,EST_CONFIRM_R1,EST_CONFIRM_R2,EST_COMPLETE,EST_ESCALATION,EST_PREV_CTX,EST_HANDOFF state;
```

```mermaid
sequenceDiagram
    autonumber
    actor Cliente
    participant EVO as Evolution API
    participant IN as WA-Inbound Entry
    participant ORQ as WA-Conversation Orchestrator
    participant AI as AI-Lead Qualification (Gemini)
    participant OUT as WA-Outbound Messages
    participant CRM as CRM-Lead Creation
    participant CU as ClickUp Sync
    participant NOTIF as Seller Notification
    
    Cliente->>EVO: Mensaje WhatsApp
    EVO->>IN: Webhook (normalizado)
    IN->>IN: Valida signature + dedup (processing_token)
    IN->>ORQ: Llama subworkflow
    
    ORQ->>ORQ: Load Conversation State (SQL)
    ORQ->>ORQ: Evaluate Conversation Step
    
    alt Saludo primera vez
        ORQ->>ORQ: welcome_and_question + baseQuestions.city
    else Recontacto (previous_lead_id)
        ORQ->>ORQ: recontact_greeting + siguiente falta
    else Pide humano
        ORQ->>ORQ: escalation_routing (human_requested)
    else Ya escalado/derivado
        alt "nueva cotización"
            ORQ->>ORQ: Reset → city
        else Otro
            ORQ->>ORQ: escalation_already_required
        end
    else En confirmación final
        alt Usuario confirma (sí/ok/dale)
            ORQ->>ORQ: shouldCreateLead=true → handoff_ready
        else Usuario rechaza (no/incorrecto)
            ORQ->>ORQ: confirmation_correction_requested
        end
    else Detecta B2B keywords
        ORQ->>ORQ: b2b_redirect (plantilla 8 campos)
    else Frustración / bucle 3+
        ORQ->>ORQ: escalation_routing
    else Intención + datos útiles
        ORQ->>ORQ: Extrae city/service/requirement
        ORQ->>AI: Execute AI Lead Qualification
        AI-->>ORQ: JSON estructurado (intent, reply_text, field_updates, etc.)
        ORQ->>ORQ: Merge AI Assistance
        ORQ->>ORQ: Apply AI Assistance (Selección Prioridad 1-5)
    end
    
    ORQ->>ORQ: Persist Conversation State (SQL TX)
    ORQ->>OUT: Respuesta seleccionada
    OUT->>EVO: sendMessage
    EVO->>Cliente: Respuesta WhatsApp
    
    alt shouldCreateLead=true
        ORQ->>CRM: Lead Creation & Assignment (round robin)
        CRM->>CU: ClickUp Sync Lead (executive_summary)
        CU->>NOTIF: Seller Notification Dispatch
        NOTIF->>Cliente: (vendedor contacta por canal aparte)
        Note over Cliente: "Te derivaré con ejecutiva..."
    end
```

```mermaid
stateDiagram-v2
    [*] --> city: Primera interacción / Reset
    
    city --> service: Ciudad detectada
    city --> city: Reintento (ciudad no reconocida)
    city --> escalation: Frustración / Bucle 3+ / Pide humano
    
    service --> requirement: Servicio detectado
    service --> service: Reintento (servicio no reconocido)
    service --> escalation: Frustración / Bucle 3+ / Pide humano
    
    requirement --> confirm: Requerimiento concreto
    requirement --> requirement: Reintento (vago)
    requirement --> escalation: Frustración / Bucle 3+ / Pide humano
    
    confirm --> complete: Usuario confirma (sí/ok/dale)
    confirm --> confirm_retry_1: Usuario rechaza (no/incorrecto)
    confirm --> escalation: Pide humano / Frustración
    
    confirm_retry_1 --> confirm_retry_2: Sigue sin corregir claro
    confirm_retry_1 --> confirm: Usuario aclara qué corregir
    confirm_retry_1 --> escalation: 2 rechazos → escalation
    
    confirm_retry_2 --> confirm: Usuario aclara
    confirm_retry_2 --> escalation: 3 intentos → escalation obligatoria
    
    complete --> [*]: Lead creado + Handoff + Outbound
    
    escalation --> [*]: Derivado a humano (outbound mensaje escalation)
    
    previous_context --> city: "nueva cotización"
    previous_context --> service: "continuar anterior" + tiene servicio
    previous_context --> requirement: "continuar anterior" + tiene req
    previous_context --> confirm: "continuar anterior" + todo completo
    previous_context --> escalation: Pide humano
    
    note right of city
        baseQuestions.city
        "Para orientarte mejor, ¿desde qué
         ciudad o comuna nos escribes?"
    end note
    
    note right of service
        baseQuestions.service
        "¿Qué necesitas resolver?
         Pastelones, baldosas, adocretos,
         cierros bulldog, adoquines, solerillas,
         bloques, maceteros..."
    end note
    
    note right of requirement
        baseQuestions.requirement
        "¿Es para cerrar terreno, patio,
         entrada vehicular, jardín u obra?
         ¿Solo material o también instalación?"
    end note
    
    note right of confirm
        confirmationText()
        "Tengo esto:
         Servicio: X
         Ciudad: Y
         Requerimiento: Z
         ¿Está correcto?"
    end note
    
    note right of confirm_retry_1
        "Entiendo. ¿Qué dato de la
         solicitud quieres corregir?"
    end note
    
    note right of complete
        shouldCreateLead=true
        Handoff → CRM → ClickUp → Notificación
        Mensaje: "Gracias por la información.
         Te derivaré con una ejecutiva..."
    end note
    
    note right of escalation
        "No quiero hacerte repetir lo mismo.
         Te derivaré con una persona del
         equipo para continuar."
    end note
```

```mermaid
flowchart LR
    subgraph PRD_VALIDATORS["PRD VALIDATORS (Guardrails duros)"]
        V1[NO_INVENT_PRICE $ + número SIN price_context]
        V2[NO_CONFIRM_STOCK 'tenemos stock' + producto]
        V3[NO_CONFIRM_PAYMENT 'pago confirmado' / 'ya puedes retirar']
        V4[NO_DISCOUNT 'te puedo hacer X%']
        V5[NO_PROMISE_DELIVERY 'llega el martes' SIN condicional]
        V6[NO_PROMISE_INSTALLATION 'instalamos' SIN condicional]
    end
    
    V1 --> F1["Fallback: Para darte un valor correcto\nnecesito revisar producto, cantidad,\ncomuna y modalidad..."]
    V2 --> F2["Fallback: Puedo levantar tu solicitud,\npero la disponibilidad debe\nconfirmarla el equipo..."]
    V3 --> F3["Fallback: Recibimos el comprobante.\nLa validación final la realiza Finanzas..."]
    V4 --> F4["Fallback: Las condiciones especiales\nlas revisa una ejecutiva..."]
    V5 --> F5["Fallback: Para revisar factibilidad\nde despacho necesitamos comuna,\nproducto, cantidad y fecha..."]
    V6 --> F6["Fallback: Para instalación necesitamos\nrevisar medidas, comuna, terreno,\nacceso y retiro de escombros..."]
    
    style V1 fill:#ffebee,stroke:#c62828
    style V2 fill:#ffebee,stroke:#c62828
    style V3 fill:#ffebee,stroke:#c62828
    style V4 fill:#ffebee,stroke:#c62828
    style V5 fill:#ffebee,stroke:#c62828
    style V6 fill:#ffebee,stroke:#c62828
    style F1 fill:#e8f5e9,stroke:#2e7d32
    style F2 fill:#e8f5e9,stroke:#2e7d32
    style F3 fill:#e8f5e9,stroke:#2e7d32
    style F4 fill:#e8f5e9,stroke:#2e7d32
    style F5 fill:#e8f5e9,stroke:#2e7d32
    style F6 fill:#e8f5e9,stroke:#2e7d32
```

```mermaid
flowchart TD
    subgraph MEMORIA["MEMORIA ESTRUCTURADA (NO texto libre)"]
        QC[qualification_context JSONB]
        PQ[pending_question_key]
        CS[current_step codificado]
        RM[recent_messages últimos 3-4]
    end
    
    QC --> Q1[name, product, commune, quantity]
    QC --> Q2[measurements, use_case, modality]
    QC --> Q3[urgency, desired_date, photos]
    QC --> Q4[terrain, truck_access, debris_removal]
    QC --> Q5[customer_type, company, company_rut]
    QC --> Q6[contact_name, contact_role, email]
    QC --> Q7[purchase_order, invoice_required]
    QC --> Q8[address, access_restrictions, reception_contact]
    QC --> Q9[sale_number, purchase_date, issue_description]
    QC --> Q10[payment_amount, payment_method, quote_number]
    QC --> Q11[diagnostic_datos, lead_class, objection_detected]
    QC --> Q12[executive_summary]
    
    PQ --> PK1[need, product, commune, modality]
    PQ --> PK2[quantity, measurements, use_case]
    PQ --> PK3[terrain, truck_access, debris_removal]
    PQ --> PK4[urgency, photos, customer_type]
    PQ --> PK5[company, company_rut, contact]
    PQ --> PK6[email, purchase_order, invoice]
    PQ --> PK7[address, desired_date, access_restrictions]
    PQ --> PK8[issue_description, payment_details]
    PQ --> PK9[final_confirmation, anything_else]
    
    CS --> ST1["city|{service,city,requirement}"]
    CS --> ST2["service_retry_1|{...}"]
    CS --> ST3["confirm_retry_2|{...}"]
    CS --> ST4["complete|{...}"]
    CS --> ST5["escalation|{...}"]
    
    RM --> R1["{role:user, content: '...'}"]
    RM --> R2["{role:assistant, content: '...'}"]
    
    subgraph INTERPRETACION_SI_NO["INTERPRETACIÓN CONTEXTUAL SÍ/NO"]
        BN[pending_question_key ∈ booleanByQuestion?]
        BN -->|Sí| SN["/^(si|sí|s|no|nop)$/.test(normalizedText)"]
        SN -->|Sí| UP["qualificationContext[campo] = true/false"]
        BN -->|No| IG[NO interpreta como confirmación global]
    end
    
    style QC fill:#e3f2fd,stroke:#1565c0
    style PQ fill:#fff3e0,stroke:#ef6c00
    style CS fill:#fce4ec,stroke:#c2185b
    style RM fill:#e8f5e9,stroke:#2e7d32
    style BN fill:#fffde7,stroke:#fbc02d
    style UP fill:#e8f5e9,stroke:#2e7d32
```

```mermaid
classDiagram
    class ConversationOrchestrator {
        +LoadConversationState()
        +EvaluateConversationStep()
        +ExecuteAILeadQualification()
        +MergeAIAssistance()
        +ApplyAIAssistance()
        +PersistConversationState()
    }
    
    class EvaluateConversationStep {
        +baseQuestions: city, service, requirement
        +knownProducts: string[]
        +knownServices: string[]
        +knownCities: string[]
        +greetingOnly: string[]
        +b2bKeywords: string[]
        +intentKeywords: string[]
        +frustrationPatterns: RegExp[]
        +detectCity(text)
        +detectActionIntent(text)
        +detectService(text)
        +detectB2bSignal(text)
        +isLikelyCityAnswer(text)
        +isLikelyServiceAnswer(text)
        +isConcreteRequirement(text)
        +nextQuestionForMissingField()
        +confirmationText()
        +handleConfirmationRejection()
        +detectFrustration(text)
        +applyDetectedFields()
    }
    
    class ApplyAIAssistance {
        +PRD_VALIDATORS: Validator[]
        +validatePrdRules(text, catalog, priceContext)
        +selectResponseText()
        +advisorQuestion(key)
        +maybeApply(field)
        +userMentionedField(field, text)
        +secondaryFieldHasDirectEvidence(key, text)
        +perFieldConfidence: object
        +aiHealthy, aiFieldsAcceptable, aiReplyAcceptable
    }
    
    class AILeadQualification {
        +BuildAIRequest()
        +systemPrompt: string (PRD completo)
        +responseSchema: JSONSchema
        +commercialContext: catalog/prices/conditions/faqs/objections
        +userPromptPayload: currentContext + commercialContext
        +CallGemini(chat/completions)
        +RetryLogic(maxAttempts=2, backoff)
    }
    
    class PRDValidator {
        +name: string
        +test(text, catalog, priceContext): boolean
        +fallback: string
    }
    
    class GeminiModel["Gemini 3.1 Flash Lite"]
    
    ConversationOrchestrator --> EvaluateConversationStep
    ConversationOrchestrator --> ApplyAIAssistance
    ConversationOrchestrator --> AILeadQualification
    ApplyAIAssistance --> PRDValidator
    AILeadQualification --> GeminiModel
```

```mermaid
erDiagram
    CONVERSATIONS ||--o{ MESSAGES : "tiene"
    CONVERSATIONS ||--o| LEADS : "genera"
    CONVERSATIONS ||--o{ ADVISOR_DECISIONS : "audita"
    CONVERSATIONS {
        bigint id PK
        bigint lead_id FK
        bigint source_number_id FK
        varchar phone_number
        int conversation_status_id FK
        varchar current_step
        jsonb qualification_context
        varchar pending_question_key
        timestamp started_at
        timestamp last_message_at
        timestamp handed_to_sales_at
        timestamp closed_at
    }
    MESSAGES {
        bigint id PK
        bigint conversation_id FK
        bigint lead_id FK
        varchar direction
        varchar message_type
        varchar external_message_id
        timestamp external_timestamp
        varchar delivery_status
        text text_body
        jsonb raw_payload
        bigint inbound_event_id FK
    }
    LEADS {
        bigint id PK
        varchar name
        varchar phone
        varchar service
        varchar city
        varchar requirement
        varchar modality
        varchar customer_type
        varchar lead_class
        bigint assigned_seller_id FK
        timestamp created_at
    }
    ADVISOR_DECISIONS {
        bigint id PK
        bigint conversation_id FK
        bigint lead_id FK
        bigint message_id FK
        varchar decision_type
        varchar sales_stage
        varchar buying_intent
        varchar urgency
        varchar next_best_action
        numeric confidence
        varchar ai_provider
        varchar ai_model
        jsonb input_payload
        jsonb output_payload
        varchar validation_result
        jsonb validation_errors
    }
    AUDIT_LOGS {
        bigint id PK
        varchar event_name
        varchar entity_type
        bigint entity_id
        varchar actor_type
        varchar actor_id
        varchar result
        jsonb before_payload
        jsonb after_payload
        jsonb metadata
    }
```

---

**Archivo guardado en**: `docs/diagrama-flujo-bot.md`

Para visualizar:
- **VS Code**: Extensión "Markdown Preview Mermaid Support" → `Ctrl+Shift+V`
- **GitHub/GitLab**: Renderiza nativo en `.md`
- **Mermaid Live Editor**: https://mermaid.live (copia-pega el contenido)
- **Obsidian/Notion**: Bloque mermaid nativo
